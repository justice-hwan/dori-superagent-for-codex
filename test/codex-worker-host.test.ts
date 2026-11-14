import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backlogAdd } from "../src/backlog.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import { workerExec } from "../src/runtime/codex/workers.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test.each(["directory", "file-alias", "trusted-alias"] as const)(
  "real hourly worker rejects workspace lookup through %s",
  async (mode) => {
    const { f, d } = await harnessFixture();
    const hostile = join(f.spec.cwd, "node_modules", ".bin");
    const trusted = join(f.root, "trusted-bin");
    for (const path of [hostile, trusted]) mkdirSync(path, { recursive: true });
    const sysctlMarker = join(f.root, "workspace-sysctl-ran");
    const ghMarker = join(f.root, "workspace-gh-ran");
    const trustedMarker = join(f.root, "trusted-gh-ran");
    for (const [path, marker, result] of [
      [join(hostile, "sysctl"), sysctlMarker, "100"],
      [join(hostile, "gh"), ghMarker, '{"state":"OPEN"}'],
      [join(trusted, "gh"), trustedMarker, '{"state":"OPEN"}'],
    ]) {
      if (!path || !marker || !result) throw new Error("Missing executable fixture input");
      writeFileSync(path, `#!/bin/sh\nprintf ran > ${quote(marker)}\nprintf '%s\\n' ${quote(result)}\n`, {
        mode: 0o755,
      });
    }
    const prefix = mode === "directory" ? hostile : join(f.root, "aliases");
    if (mode !== "directory") {
      mkdirSync(prefix);
      const target = mode === "file-alias" ? join(hostile, "gh") : join(trusted, "operator-gh");
      if (mode === "trusted-alias")
        writeFileSync(
          target,
          `#!/bin/sh\ncase "\${0##*/}" in gh) ;; *) exit 17;; esac\nprintf ran > ${quote(trustedMarker)}\nprintf '%s\\n' '{"state":"OPEN"}'\n`,
          { mode: 0o755 },
        );
      symlinkSync(target, join(prefix, "gh"));
    }
    const brief = join(f.spec.cwd, "brief.md");
    writeFileSync(brief, "No task is started; exercise the hourly issue-state read only.");
    backlogAdd(d, "boundary-item", brief, { cwd: f.spec.cwd, source: "fixture/repo#1" });
    const runtime = new CodexRuntime(f.root, {
      ...f.env,
      PATH: `${prefix}:${hostile}:${trusted}:/usr/bin:/bin:/usr/sbin:/sbin`,
      BUN_BIN: process.execPath,
      DORI_TELEMETRY: "0",
    });
    const ref = await runtime.create({ ...f.spec, name: "host-boundary", role: "hourly-loop" });
    const recorded = Promise.withResolvers<void>();
    const watcher = watch(join(f.root, "loop"), (_event, name) => {
      if (name === "last-run.json") recorded.resolve();
    });
    const spawned = spyOn(childProcess, "spawn");
    f.cleanup.push(async () => {
      watcher.close();
      const result = spawned.mock.results[0];
      const worker = result?.type === "return" ? result.value : undefined;
      const exited =
        !worker || worker.exitCode !== null || worker.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      try {
        await runtime.close(ref);
        await exited;
      } finally {
        spawned.mockRestore();
      }
    });

    await runtime.start(ref, `${runtime.prepareHost(f.spec.cwd).command} loop`);
    await recorded.promise;

    const run = object(await Bun.file(join(f.root, "loop", "last-run.json")).json());
    expect(typeof object(object(run["status"])["host"])["memFreePct"]).toBe("number");
    expect((await runtime.probe(ref)).status).toBe("working");
    expect(f.calls).toEqual([]);
    expect({
      workspaceSysctl: existsSync(sysctlMarker),
      workspaceGh: existsSync(ghMarker),
      trustedGh: existsSync(trustedMarker),
    }).toEqual({ workspaceSysctl: false, workspaceGh: false, trustedGh: mode !== "file-alias" });
    expect(run["findings"]).toHaveLength(mode === "file-alias" ? 1 : 0);
  },
);

test("real host memory probe pins sysctl independently of its caller search path", async () => {
  const { f } = await harnessFixture();
  const hostile = join(f.spec.cwd, "node_modules", ".bin");
  mkdirSync(hostile, { recursive: true });
  const marker = join(f.root, "direct-workspace-sysctl-ran");
  writeFileSync(join(hostile, "sysctl"), `#!/bin/sh\nprintf ran > ${quote(marker)}\nprintf '100\\n'\n`, {
    mode: 0o755,
  });
  const host = f.rt.prepareHost(f.spec.cwd);
  const script = `import {memFreePct} from ${JSON.stringify(join(host.directory, "src/host.ts"))}; console.log(memFreePct("darwin"));`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...f.env, PATH: `${hostile}:/usr/bin:/bin:/usr/sbin:/sbin` },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(Number.isFinite(Number((await new Response(child.stdout).text()).trim()))).toBe(true);
  expect(existsSync(marker)).toBe(false);
});

test("worker command entry inside the workspace is refused even when its target is trusted", async () => {
  const { f } = await harnessFixture();
  const marker = join(f.root, "safe-command-ran");
  const target = join(f.root, "safe-command");
  writeFileSync(target, `#!/bin/sh\nprintf ran > ${quote(marker)}\n`, { mode: 0o755 });
  const entry = join(f.spec.cwd, "mutable-entry");
  symlinkSync(target, entry);

  await expect(workerExec(f.spec.cwd)(entry, [])).rejects.toMatchObject({ kind: "ownership" });

  expect(existsSync(marker)).toBe(false);
});
