import { describe, expect, it } from "vitest";
import {
  resolvePackageBin,
  resolvePackageRequire,
  runNodePackageBin,
} from "../../scripts/local-package-bin.mjs";

function normalizePath(targetPath: string) {
  return targetPath.replaceAll("\\", "/");
}

describe("scripts/local-package-bin", () => {
  it("resolves direct workspace tool bins", () => {
    const tscPath = normalizePath(resolvePackageBin("typescript", { binName: "tsc" }));
    expect(tscPath).toContain("/typescript/bin/tsc");
  });

  it("can resolve transitive bins through another package context", () => {
    const tsdownRequire = resolvePackageRequire("tsdown");
    const rolldownPath = normalizePath(
      resolvePackageBin("rolldown", { baseRequire: tsdownRequire }),
    );
    expect(rolldownPath).toContain("/rolldown/bin/cli.mjs");
  });

  it("runs local node package bins without shelling out to pnpm", () => {
    const result = runNodePackageBin({
      packageName: "typescript",
      binName: "tsc",
      args: ["--version"],
      stdio: "pipe",
    });
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toContain("Version 5.");
  });
});