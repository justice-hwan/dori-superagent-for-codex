import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

type Owner = { pid: number; nonce: string };
export type FileLease = { holds(): boolean; release(): void };
const read = (path: string): Owner | undefined => {
  try { return JSON.parse(readFileSync(path, "utf8")) as Owner; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error(`cannot read lock ${path}; inspect it before recovery`); }
};
const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid lock owner; inspect it before recovery");
  try { process.kill(pid, 0); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
};

/**
 * Serialize stale-owner checks and replacement behind an atomic claim gate.
 * A crash during the short claim section leaves the gate for explicit inspection;
 * it is never automatically unlinked, avoiding recursive stale-takeover races.
 */
export function acquireFileLease(path: string): FileLease | undefined {
  const owner: Owner = { pid: process.pid, nonce: randomUUID() };
  const candidate = `${path}.candidate.${owner.nonce}`, gate = `${path}.claim`;
  writeFileSync(candidate, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  let gated = false;
  try {
    try { linkSync(candidate, gate); gated = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw e; }
    const old = read(path);
    if (old) {
      if (alive(old.pid)) return undefined;
      unlinkSync(path); // All reclaimers hold this same gate before inspecting or replacing the owner.
    }
    linkSync(candidate, path);
    return {
      holds: () => read(path)?.nonce === owner.nonce,
      release: () => { if (read(path)?.nonce === owner.nonce) unlinkSync(path); },
    };
  } finally {
    if (gated) unlinkSync(gate);
    unlinkSync(candidate);
  }
}
