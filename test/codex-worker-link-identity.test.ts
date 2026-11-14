import { expect, onTestFinished, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnExec } from "../src/runtime/exec.ts";
import { workerExec } from "../src/runtime/codex/workers.ts";
import { CodexError } from "../src/runtime/codex/protocol.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const swapCase = (name: string) =>
  [...name].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
const sameDirectoryCaseAlias = (path: string) => {
  const alias = join(dirname(path), swapCase(basename(path)));
  if (alias === path || !existsSync(alias)) return null;
  const [a, b] = [statSync(alias, { bigint: true }), statSync(path, { bigint: true })];
  return a.dev === b.dev && a.ino === b.ino ? alias : null;
};
const homeVolumeSensitive = sameDirectoryCaseAlias(homedir()) === null;
const roots = [
  { root: "workspace", base: null, sensitive: homeVolumeSensitive },
  ...[...new Set([realpathSync(tmpdir()), realpathSync("/tmp")])].map((base) => ({
    root: base,
    base,
    sensitive: sameDirectoryCaseAlias(base) === null,
  })),
];

const fixture = (base: string | null) => {
  const home = mkdtempSync(join(homedir(), ".dori-link-identity-"));
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const writable = base === null ? workspace : mkdtempSync(join(base, "dori-link-identity-"));
  onTestFinished(() => {
    if (base !== null) rmSync(writable, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const protectedRoot = join(home, "protected");
  for (const path of [join(protectedRoot, "bin"), join(protectedRoot, "libexec"), join(writable, "payload")])
    mkdirSync(path, { recursive: true });
  const safeMarker = join(home, "safe-ran");
  const evilMarker = join(home, "writable-ran");
  const safe = join(protectedRoot, "libexec", "gh");
  const evil = join(writable, "payload", "gh");
  writeFileSync(safe, `#!/bin/sh\nprintf safe > ${quote(safeMarker)}\nprintf 'safe %s\\n' "\${0##*/}"\n`, {
    mode: 0o755,
  });
  writeFileSync(evil, `#!/bin/sh\nprintf writable > ${quote(evilMarker)}\n`, { mode: 0o755 });
  const alias =
    base === null ? sameDirectoryCaseAlias(workspace) : join(sameDirectoryCaseAlias(base) ?? base, basename(writable));
  return { home, workspace, writable, alias, protectedRoot, safe, evil, safeMarker, evilMarker };
};
type Fixture = ReturnType<typeof fixture>;

const provenSafe = async (f: Fixture, entry: string) => {
  expect(await spawnExec(entry, [])).toMatchObject({ code: 0, stdout: "safe gh\n" });
  expect(existsSync(f.safeMarker)).toBe(true);
  expect(existsSync(f.evilMarker)).toBe(false);
  expect(realpathSync(entry)).toBe(realpathSync(f.safe));
};

const outcome = async (run: Promise<unknown>) => {
  try {
    await run;
    return "spawned";
  } catch (error) {
    if (error instanceof CodexError) return error.kind;
    if (error instanceof Error) return error.message;
    throw error;
  }
};

for (const { root, base, sensitive } of roots)
  test.skipIf(sensitive)(`worker refuses a case-variant spelling of writable root ${root}`, async () => {
    const f = fixture(base);
    expect(f.alias).not.toBeNull();
    const relay = join(f.writable, "relay");
    symlinkSync(f.safe, relay);
    const entry = join(f.protectedRoot, "bin", "gh");
    symlinkSync(join(f.alias ?? "", "relay"), entry);
    await provenSafe(f, entry);

    const spawn = Bun.spawn;
    let boundaryReached = false;
    const intercepted = spyOn(Bun, "spawn").mockImplementationOnce((command, options?: Parameters<typeof spawn>[1]) => {
      expect(realpathSync(entry)).toBe(realpathSync(f.safe));
      boundaryReached = true;
      unlinkSync(relay);
      symlinkSync(f.evil, relay);
      if (!Array.isArray(command)) throw new Error("spawnExec invokes Bun.spawn with an argv array");
      return spawn(command, options);
    });
    let refusal: string;
    try {
      refusal = await outcome(workerExec(f.workspace)(entry, []));
    } finally {
      intercepted.mockRestore();
    }
    const writableExecuted = existsSync(f.evilMarker);
    console.info("CASE_ALIAS_BOUNDARY", { root, alias: f.alias, boundaryReached, writableExecuted, refusal });
    expect({ writableExecuted, refusal }).toEqual({ writableExecuted: false, refusal: "ownership" });
  });

const selfLinkOutcome = async (f: Fixture, entry: string, relay: string, walked: string) => {
  const lstat = fs.lstatSync;
  let expansions = 0;
  const visit = (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === walked) {
      if (expansions === 0) {
        unlinkSync(relay);
        symlinkSync(basename(relay), relay);
      }
      // An event-driven ceiling surfaces non-termination as a failure instead of a hung test.
      if (++expansions > 1000) throw new Error("unbounded link expansion");
    }
    return lstat(...args);
  };
  const visits = spyOn(fs, "lstatSync").mockImplementation(visit as typeof lstat);
  let result: string;
  try {
    result = await outcome(workerExec(f.workspace)(entry, []));
  } finally {
    visits.mockRestore();
  }
  console.info("SELF_LINK_BOUNDARY", { walked, expansions, outcome: result });
  return result;
};

test.skipIf(homeVolumeSensitive)(
  "a post-validation self-link through a case-variant writable root is refused",
  async () => {
    const f = fixture(null);
    const relay = join(f.workspace, "relay");
    symlinkSync(f.safe, relay);
    const entry = join(f.protectedRoot, "bin", "gh");
    symlinkSync(join(f.alias ?? "", "relay"), entry);
    await provenSafe(f, entry);
    expect(await selfLinkOutcome(f, entry, relay, join(f.alias ?? "", "relay"))).toBe("ownership");
  },
);

test("a post-validation protected self-link fails closed within a finite expansion bound", async () => {
  const f = fixture(null);
  const relay = join(f.protectedRoot, "relay");
  symlinkSync(f.safe, relay);
  const entry = join(f.protectedRoot, "bin", "gh");
  symlinkSync(relay, entry);
  await provenSafe(f, entry);
  expect(await selfLinkOutcome(f, entry, relay, relay)).toBe("ownership");
});
