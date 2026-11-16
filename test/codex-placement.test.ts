import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { fixture } from "./codex-fixture.test.ts";

test.each(["lead", "duty", "lane", "duty-loop", "hourly-loop"] as const)(
  "native %s refuses authority inside the task workspace with the bridge unset",
  async (role) => {
    const f = await fixture();
    const root = join(f.spec.cwd, ".dori");
    mkdirSync(root);
    const runtime = new CodexRuntime(root, {
      ...f.env,
      DORI_CODEX_BRIDGE: undefined,
    });
    await expect(runtime.create({ ...f.spec, role })).rejects.toMatchObject({
      kind: "ownership",
    });
    expect(f.threads.size).toBe(0);
  },
);

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
