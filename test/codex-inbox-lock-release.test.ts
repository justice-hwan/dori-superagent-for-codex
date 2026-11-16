import { expect, onTestFinished, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { takeInboxLock } from "../src/inbox-lock.ts";
import { setup } from "./inbox-setup.ts";

for (const metadataAfterReservation of [false, true]) {
  test(`metadata release follows opted-in reservation ordering: ${metadataAfterReservation}`, () => {
    const s = setup();
    const path = `${s.d.store.root}/inbox/release.lock`;
    const release = takeInboxLock(path, s.w.clock, { metadataAfterReservation });
    if (!release) throw new Error("Missing fixture reservation");
    const remove = fs.rmSync;
    let reservedAtUnlink = false;
    const unlink = spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (target === path) {
        using contender = new Database(`${path}.gate.sqlite`);
        try {
          contender.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
          reservedAtUnlink = true;
          contender.exec("ROLLBACK");
        } catch (error) {
          if (!(error instanceof Error) || Reflect.get(error, "code") !== "SQLITE_BUSY") throw error;
        }
        // The live metadata still blocks ordinary contenders during the close/unlink gap.
        expect(takeInboxLock(path, s.w.clock + 1)).toBeUndefined();
      }
      return remove(target, options);
    });
    onTestFinished(() => {
      unlink.mockRestore();
      release();
    });
    release();
    expect(reservedAtUnlink).toBe(metadataAfterReservation);
    expect(fs.existsSync(path)).toBe(false);
    const next = takeInboxLock(path, s.w.clock + 2, { metadataAfterReservation });
    expect(next).toBeDefined();
    next?.();
  });
}

test("opted-in release preserves a replacement owner's metadata and is idempotent", () => {
  const s = setup();
  const path = `${s.d.store.root}/inbox/replacement.lock`;
  const release = takeInboxLock(path, s.w.clock, { metadataAfterReservation: true });
  if (!release) throw new Error("Missing fixture reservation");
  const replacement = JSON.stringify({ pid: process.pid, host: "fixture-successor", at: s.w.clock + 1 });
  fs.writeFileSync(path, replacement);
  release();
  release();
  expect(fs.readFileSync(path, "utf8")).toBe(replacement);
  using next = new Database(`${path}.gate.sqlite`);
  expect(() => next.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
});

test("crash after reservation close leaves recoverable opted-in metadata", async () => {
  const s = setup();
  const path = `${s.d.store.root}/inbox/crash.lock`;
  const script = `
import * as fs from "node:fs";
import { spyOn } from "bun:test";
import { takeInboxLock } from ${JSON.stringify(new URL("../src/inbox-lock.ts", import.meta.url).href)};
const path = ${JSON.stringify(path)};
const release = takeInboxLock(path, 1, { metadataAfterReservation: true });
if (!release) throw new Error("Missing child reservation");
const remove = fs.rmSync;
spyOn(fs, "rmSync").mockImplementation((target, options) => {
  if (target === path) process.kill(process.pid, "SIGKILL");
  return remove(target, options);
});
release();
throw new Error("Crash cut was not reached");
`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  onTestFinished(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  expect(fs.existsSync(path)).toBe(true);
  const recovered = takeInboxLock(path, s.w.clock, { metadataAfterReservation: true });
  expect(recovered).toBeDefined();
  recovered?.();
  expect(fs.existsSync(path)).toBe(false);
});
