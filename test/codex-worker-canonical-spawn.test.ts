import { expect, onTestFinished, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnExec } from "../src/runtime/exec.ts";
import { workerExec } from "../src/runtime/codex/workers.ts";
import { CodexError } from "../src/runtime/codex/protocol.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("a relay retargeted after validation cannot change the executed file", async () => {
  const home = mkdtempSync(join(homedir(), ".dori-canonical-spawn-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  const protectedRoot = join(home, "protected");
  for (const path of [join(workspace, "payload"), join(protectedRoot, "bin"), join(protectedRoot, "libexec")])
    mkdirSync(path, { recursive: true });
  // Stands in for a pre-existing mount exposing a writable subtree at a protected path.
  const exposed = join(protectedRoot, "view");
  mkdirSync(exposed);
  const safeMarker = join(home, "safe-ran");
  const evilMarker = join(home, "writable-ran");
  const safe = join(protectedRoot, "libexec", "gh");
  const evil = join(workspace, "payload", "gh");
  writeFileSync(safe, `#!/bin/sh\nprintf safe > ${quote(safeMarker)}\n`, { mode: 0o755 });
  writeFileSync(evil, `#!/bin/sh\nprintf writable > ${quote(evilMarker)}\n`, { mode: 0o755 });
  const relay = join(exposed, "relay");
  symlinkSync(safe, relay);
  const entry = join(protectedRoot, "bin", "gh");
  symlinkSync(relay, entry);

  expect(await spawnExec(entry, [])).toMatchObject({ code: 0 });
  expect(existsSync(safeMarker)).toBe(true);
  expect(realpathSync(entry)).toBe(realpathSync(safe));
  unlinkSync(safeMarker);

  const spawn = Bun.spawn;
  const intercepted = spyOn(Bun, "spawn").mockImplementationOnce((command, options?: Parameters<typeof spawn>[1]) => {
    unlinkSync(relay);
    symlinkSync(evil, relay);
    if (!Array.isArray(command)) throw new Error("spawnExec invokes Bun.spawn with an argv array");
    return spawn(command, options);
  });
  try {
    await workerExec(workspace)(entry, []);
  } finally {
    intercepted.mockRestore();
  }
  const executed = { safe: existsSync(safeMarker), writable: existsSync(evilMarker) };
  console.info("CANONICAL_SPAWN_BOUNDARY", executed);
  expect(executed).toEqual({ safe: true, writable: false });
});

test("a writable relay cannot choose which protected file is validated", async () => {
  const home = mkdtempSync(join(homedir(), ".dori-canonical-select-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  const protectedRoot = join(home, "protected");
  for (const path of [workspace, join(protectedRoot, "bin"), join(protectedRoot, "libexec")])
    mkdirSync(path, { recursive: true });
  const decoyMarker = join(home, "decoy-ran");
  const decoy = join(protectedRoot, "libexec", "decoy");
  writeFileSync(decoy, `#!/bin/sh\nprintf decoy > ${quote(decoyMarker)}\n`, { mode: 0o755 });
  const relay = join(workspace, "relay");
  symlinkSync(decoy, relay);
  const entry = join(protectedRoot, "bin", "gh");
  symlinkSync(relay, entry);

  let outcome = "spawned";
  try {
    await workerExec(workspace)(entry, []);
  } catch (error) {
    if (!(error instanceof CodexError)) throw error;
    outcome = error.kind;
  }
  expect({ outcome, decoyRan: existsSync(decoyMarker) }).toEqual({ outcome: "ownership", decoyRan: false });
});
