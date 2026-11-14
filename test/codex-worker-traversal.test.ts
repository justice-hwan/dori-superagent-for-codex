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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec } from "../src/runtime/exec.ts";
import { workerExec } from "../src/runtime/codex/workers.ts";
import { CodexError } from "../src/runtime/codex/protocol.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const roots = [
  { root: "workspace", base: null },
  ...[...new Set([realpathSync(tmpdir()), realpathSync("/tmp")])].map((base) => ({ root: base, base })),
];
const shapes = [
  { shape: "file", directory: false, parent: false, parentComponents: false },
  { shape: "directory-target", directory: true, parent: false, parentComponents: false },
  { shape: "parent-directory", directory: true, parent: true, parentComponents: false },
  { shape: "parent-components", directory: true, parent: false, parentComponents: true },
];

test.each(roots.flatMap((root) => shapes.map((shape) => ({ ...root, ...shape }))))(
  "worker refuses $shape traversal through $root before a controlled retarget can execute",
  async ({ root, base, shape, directory, parent, parentComponents }) => {
    const home = mkdtempSync(join(homedir(), ".dori-traversal-"));
    const workspace = join(home, "workspace");
    const protectedRoot = join(home, "protected");
    const writable = base === null ? workspace : mkdtempSync(join(base, "dori-traversal-"));
    onTestFinished(() => {
      if (base !== null) rmSync(writable, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });
    for (const path of [
      workspace,
      join(protectedRoot, "bin"),
      join(protectedRoot, "libexec"),
      join(writable, "payload"),
    ])
      mkdirSync(path, { recursive: true });
    const safeMarker = join(home, "safe-ran");
    const evilMarker = join(home, "writable-ran");
    const safe = join(protectedRoot, "libexec", "gh");
    const evil = join(writable, "payload", "gh");
    writeFileSync(safe, `#!/bin/sh\nprintf safe > ${quote(safeMarker)}\nprintf 'safe %s\\n' "\${0##*/}"\n`, {
      mode: 0o755,
    });
    writeFileSync(evil, `#!/bin/sh\nprintf writable > ${quote(evilMarker)}\n`, { mode: 0o755 });
    const relay = join(writable, "relay");
    symlinkSync(directory ? join(protectedRoot, "libexec") : safe, relay);
    const entry = parent ? join(protectedRoot, "command-dir", "gh") : join(protectedRoot, "bin", "gh");
    if (parentComponents) {
      mkdirSync(join(protectedRoot, "libexec", "deep"));
      mkdirSync(join(writable, "payload", "deep"));
      symlinkSync(`${relay}/deep`, join(protectedRoot, "outer"));
      symlinkSync(safe, join(protectedRoot, "gh"));
      symlinkSync(`${protectedRoot}/outer/../gh`, entry);
    } else
      symlinkSync(
        parent ? relay : directory ? `${relay}/gh` : relay,
        parent ? join(protectedRoot, "command-dir") : entry,
      );

    // A real successful platform invocation proves the chain is initially safe.
    expect(await spawnExec(entry, [])).toMatchObject({ code: 0, stdout: "safe gh\n" });
    expect(existsSync(safeMarker)).toBe(true);
    expect(existsSync(evilMarker)).toBe(false);
    expect(realpathSync(entry)).toBe(realpathSync(safe));

    const spawn = Bun.spawn;
    let boundaryReached = false;
    let refusal: string | undefined;
    const intercepted = spyOn(Bun, "spawn").mockImplementationOnce((command, options?: Parameters<typeof spawn>[1]) => {
      expect(realpathSync(entry)).toBe(realpathSync(safe));
      boundaryReached = true;
      unlinkSync(relay);
      symlinkSync(directory ? join(writable, "payload") : evil, relay);
      if (!Array.isArray(command)) throw new Error("spawnExec invokes Bun.spawn with an argv array");
      return spawn(command, options);
    });
    try {
      await workerExec(workspace)(entry, []);
    } catch (error) {
      if (!(error instanceof CodexError)) throw error;
      refusal = error.kind;
    } finally {
      intercepted.mockRestore();
    }
    const writableExecuted = existsSync(evilMarker);
    console.info("TRAVERSAL_BOUNDARY", {
      root,
      shape,
      safeBeforeRetarget: true,
      boundaryReached,
      writableExecuted,
      refusal,
    });
    expect({ writableExecuted, refusal }).toEqual({ writableExecuted: false, refusal: "ownership" });
  },
);

test.each([false, true])(
  "protected multihop command aliases retain invocation name with parents=%s",
  async (parents) => {
    const home = mkdtempSync(join(homedir(), ".dori-traversal-safe-"));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const workspace = join(home, "workspace");
    const bin = join(home, "protected", "bin");
    mkdirSync(workspace);
    mkdirSync(bin, { recursive: true });
    const marker = join(home, "safe-ran");
    const libexec = join(home, "protected", "libexec");
    mkdirSync(join(libexec, "deep"), { recursive: true });
    const tool = join(parents ? libexec : join(home, "protected"), "implementation");
    writeFileSync(tool, `#!/bin/sh\nprintf safe > ${quote(marker)}\nprintf '%s\\n' "\${0##*/}"\n`, { mode: 0o755 });
    symlinkSync(parents ? "../libexec/deep" : tool, join(bin, "relay"));
    const entry = join(bin, "gh");
    symlinkSync(parents ? "relay/../implementation" : "relay", entry);

    expect(await workerExec(workspace)(entry, [])).toMatchObject({ code: 0, stdout: "gh\n" });
    expect(existsSync(marker)).toBe(true);
  },
);
