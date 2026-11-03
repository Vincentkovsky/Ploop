import { realpath, lstat, stat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { git, PloopError, sha256 } from "./runtime.mjs";
import { projectInput } from "./contracts.mjs";

export async function bindProject(input) {
  const config = projectInput(input);
  if (!isAbsolute(config.repository)) throw new PloopError("invalid_request", "Repository must be an absolute path");
  const repository = await realpath(config.repository);
  if (await realpath(await git(repository, ["rev-parse", "--show-toplevel"])) !== repository)
    throw new PloopError("invalid_request", "Bind the repository root, not a subdirectory");
  const commonDirectory = await realpath(await git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const identity = await stat(commonDirectory);
  for (const path of config.allowedPaths) {
    const source = join(repository, path), info = await lstat(source);
    if (!info.isFile() || await realpath(source) !== source) throw new PloopError("invalid_request", "Allowed paths must be regular files without symlink aliases", { path });
  }
  const sourceFiles = [];
  for (const selectedPath of config.acceptance.sourceFiles) {
    if (!isAbsolute(selectedPath)) throw new PloopError("invalid_request", "Verification source paths must be absolute");
    const path = await realpath(selectedPath), info = await stat(path);
    if (!info.isFile() || info.size > 1_048_576) throw new PloopError("invalid_request", "Verification source must be a regular file within its 1 MiB budget");
    sourceFiles.push({ selectedPath, path, sha256: sha256(await readFile(path)) });
  }
  return { ...config, selectedRepository: config.repository, repository, acceptance: { ...config.acceptance, sourceFiles },
    gitIdentity: { commonDirectory, dev: identity.dev, ino: identity.ino, bindingCommit: await git(repository, ["rev-parse", "HEAD"]) } };
}
export async function snapshotProject(config) {
  await checkRepositoryIdentity(config);
  if (await git(config.repository, ["status", "--porcelain", "--untracked-files=no"]))
    throw new PloopError("repository_dirty", "Commit or preserve tracked local changes before approving a task; Ploop will not stash them");
  await checkAcceptanceSources(config.acceptance);
  const baseCommit = await git(config.repository, ["rev-parse", "HEAD"]);
  const inventory = await inspectCommit(config.repository, baseCommit);
  if (config.allowedPaths.some((path) => !inventory.paths.includes(path))) throw new PloopError("project_changed", "An authorized file is not present in the selected commit");
  const snapshot = { schemaVersion: 1, config, baseCommit, inventory };
  return { ...snapshot, digest: sha256(JSON.stringify(snapshot)) };
}
export async function checkRepositoryIdentity(config) {
  const common = await realpath(await git(config.repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const identity = await stat(common);
  if (common !== config.gitIdentity.commonDirectory || identity.dev !== config.gitIdentity.dev || identity.ino !== config.gitIdentity.ino)
    throw new PloopError("repository_changed", "Repository identity changed; bind it again");
  await git(config.repository, ["cat-file", "-e", `${config.gitIdentity.bindingCommit}^{commit}`]);
}

export async function inspectCommit(repository, commit) {
  const raw = await git(repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit], { raw: true });
  if (raw.includes("\ufffd")) throw new PloopError("snapshot_unsupported", "Git path bytes cannot be represented by this UTF-8 execution profile");
  let totalBytes = 0; const paths = [];
  for (const entry of raw.split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]+) +([0-9]+|-)\t([\s\S]+)$/.exec(entry);
    if (!match || !["100644", "100755"].includes(match[1]) || match[2] !== "blob") throw new PloopError("snapshot_unsupported", "This local profile supports regular tracked files, without symlinks or submodules");
    const size = Number(match[4]); totalBytes += size;
    if (!Number.isSafeInteger(size) || size > 8 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024 || paths.length >= 5000)
      throw new PloopError("snapshot_capacity", "Snapshot exceeds the local profile's file-count or byte budget");
    paths.push(match[5]);
  }
  return { fileCount: paths.length, totalBytes, paths };
}
export async function checkAcceptanceSources(acceptance, writableRoot) {
  for (const file of acceptance.sourceFiles) {
    const rel = writableRoot ? relative(writableRoot, file.path) : null;
    if (rel !== null && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      throw new PloopError("acceptance_writable", "Owner acceptance cannot live in the Agent's writable worktree");
    if (await realpath(file.path) !== file.path || sha256(await readFile(file.path)) !== file.sha256)
      throw new PloopError("acceptance_changed", "Owner-controlled acceptance changed; approve a fresh configuration");
  }
}
