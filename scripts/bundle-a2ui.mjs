#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolvePackageRequire, runNodePackageBin } from "./local-package-bin.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hashFile = path.join(repoRoot, "src", "canvas-host", "a2ui", ".bundle.hash");
const outputFile = path.join(repoRoot, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const a2uiRendererDir = path.join(repoRoot, "vendor", "a2ui", "renderers", "lit");
const a2uiAppDir = path.join(repoRoot, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");
const inputPaths = [
  path.join(repoRoot, "package.json"),
  path.join(repoRoot, "pnpm-lock.yaml"),
  a2uiRendererDir,
  a2uiAppDir,
];

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(entryPath, files = []) {
  const st = await fs.stat(entryPath);
  if (st.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await collectFiles(path.join(entryPath, entry), files);
    }
    return files;
  }
  files.push(entryPath);
  return files;
}

function normalizePath(targetPath) {
  return targetPath.split(path.sep).join("/");
}

async function computeHash() {
  const files = [];
  for (const entryPath of inputPaths) {
    await collectFiles(entryPath, files);
  }
  files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(normalizePath(path.relative(repoRoot, filePath)));
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function getRolldownRequire() {
  const repoRequire = createRequire(import.meta.url);
  try {
    repoRequire.resolve("rolldown/package.json");
    return repoRequire;
  } catch {
    const tsdownRequire = resolvePackageRequire("tsdown", repoRequire);
    tsdownRequire.resolve("rolldown/package.json");
    return tsdownRequire;
  }
}

function ensureSuccess(result, label) {
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} exited with status ${String(result.status ?? 1)}.`);
  }
}

async function main() {
  const sourcesMissing = !(await exists(a2uiRendererDir)) || !(await exists(a2uiAppDir));
  if (sourcesMissing) {
    if (await exists(outputFile)) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      return;
    }
    throw new Error(`A2UI sources missing and no prebuilt bundle found at: ${outputFile}`);
  }

  const currentHash = await computeHash();
  if ((await exists(hashFile)) && (await exists(outputFile))) {
    const previousHash = (await fs.readFile(hashFile, "utf8")).trim();
    if (previousHash === currentHash) {
      console.log("A2UI bundle up to date; skipping.");
      return;
    }
  }

  ensureSuccess(
    runNodePackageBin({
      packageName: "typescript",
      binName: "tsc",
      args: ["-p", path.join(a2uiRendererDir, "tsconfig.json")],
      cwd: repoRoot,
    }),
    "TypeScript",
  );

  ensureSuccess(
    runNodePackageBin({
      packageName: "rolldown",
      args: ["-c", path.join(a2uiAppDir, "rolldown.config.mjs")],
      baseRequire: getRolldownRequire(),
      cwd: repoRoot,
    }),
    "Rolldown",
  );

  await fs.writeFile(hashFile, `${currentHash}\n`, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  process.exit(1);
});