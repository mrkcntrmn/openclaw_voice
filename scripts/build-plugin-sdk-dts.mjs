#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNodePackageBin } from "./local-package-bin.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = runNodePackageBin({
  packageName: "typescript",
  binName: "tsc",
  args: ["-p", "tsconfig.plugin-sdk.dts.json"],
  cwd: repoRoot,
});

if (result.error) {
  throw result.error;
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);