# Order export example

This example deliberately contains a first-page-only export bug. Ploop copies it
into a new local Git repository for each PoC run. No production API is called.

Only `src/export-orders.mjs` is an authorized edit target. The supplied feedback
describes the expected pagination behavior. Independent acceptance tests live in
Ploop's `acceptance/` directory, outside the Agent's writable worktree.
