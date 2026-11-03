import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const acceptancePath = join(projectRoot, "acceptance/orders.test.mjs");
