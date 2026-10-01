#!/usr/bin/env node
// npm test: every test/*.test.mjs, named one by one. A glob in package.json
// would rely on the shell to expand it, and on Windows npm runs scripts with
// cmd.exe, which does not; node --test expands globs itself only from Node
// 21, so on Windows with Node 20 it found no tests. Arguments are passed on
// to node --test, such as --test-name-pattern.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => join(dir, f));
const { status, error } = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  stdio: "inherit",
});
if (error) {
  console.error(error.message);
  process.exit(1);
}
process.exit(status ?? 1);
