import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test.each(["capabilities", "nested-capabilities", "snapshot", "symlink-capabilities", "symlink-snapshot"])(
  "bridge refuses writable authority/code overlap: %s",
  async (mode) => {
    const isolated = mkdtempSync(join(homedir(), ".dori-placement-test-"));
    onTestFinished(() => rmSync(isolated, { recursive: true, force: true }));
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("./fixtures/codex-placement.ts", import.meta.url)), mode],
      {
        env: { ...process.env, HOME: isolated },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ accepted: false, kind: "ownership" });
  },
);
