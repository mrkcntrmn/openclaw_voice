#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const defaultRequire = createRequire(import.meta.url);

function readPackageJson(packageJsonPath) {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function selectBinEntry(pkg, packageName, binName) {
  if (typeof pkg.bin === "string") {
    return pkg.bin;
  }
  if (!pkg.bin || typeof pkg.bin !== "object") {
    throw new Error(`${packageName} does not declare a runnable bin entry.`);
  }
  return (
    pkg.bin[binName] ??
    pkg.bin[packageName] ??
    Object.values(pkg.bin).find((candidate) => typeof candidate === "string")
  );
}

export function resolvePackageRequire(packageName, baseRequire = defaultRequire) {
  const packageJsonPath = baseRequire.resolve(`${packageName}/package.json`);
  return createRequire(packageJsonPath);
}

export function resolvePackageBin(packageName, options = {}) {
  const { baseRequire = defaultRequire, binName = packageName } = options;
  const packageJsonPath = baseRequire.resolve(`${packageName}/package.json`);
  const pkg = readPackageJson(packageJsonPath);
  const relativeBinPath = selectBinEntry(pkg, packageName, binName);
  if (!relativeBinPath) {
    throw new Error(`${packageName} does not declare a "${binName}" bin entry.`);
  }
  return path.resolve(path.dirname(packageJsonPath), relativeBinPath);
}

export function runNodePackageBin(options) {
  const {
    args = [],
    baseRequire = defaultRequire,
    binName,
    cwd = process.cwd(),
    env = process.env,
    packageName,
    stdio = "inherit",
  } = options;
  const binPath = resolvePackageBin(packageName, { baseRequire, binName });
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    env,
    stdio,
  });
}