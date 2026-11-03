import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { integratePair, recoverIntegration, type Pair } from "../src/merge.ts";
import { Store } from "../src/store.ts";
import { spawnExec, type Exec } from "../src/process.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dori-atomic-merge-")), repo = join(root, "repo"), bare = join(root, "remote.git"); mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, "base.txt"), "base\n"); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  git("init", "--bare", "-q", bare); git("push", "-q", bare, "HEAD:refs/heads/main");
  git("switch", "-qc", "feature"); writeFileSync(join(repo, "reviewed.txt"), "reviewed\n"); git("add", "."); git("commit", "-qm", "reviewed head"); const head = git("rev-parse", "HEAD");
  const advance = git("commit-tree", git("rev-parse", `${base}^{tree}`), "-p", base, "-m", "concurrent base"); git("push", "-q", bare, `${advance}:refs/heads/advance`);
  writeFileSync(join(repo, "unreviewed.txt"), "new unreviewed work\n"); git("add", "."); git("commit", "-qm", "new head"); const newerHead = git("rev-parse", "HEAD");
  git("config", `url.${bare}.insteadOf`, "https://github.com/fixture/project.git");
  const store = new Store(join(root, "state"));
  const pair: Pair = { head, base, baseBranch: "main", state: "OPEN", draft: false };
  const target = { id: "fixture/project#1", repo: "fixture/project" };
  const exec: Exec = (cmd, args) => spawnExec(cmd, cmd === "git" ? ["-C", repo, ...args] : args);
  const tip = () => git("--git-dir", bare, "rev-parse", "refs/heads/main");
  const readTarget = async (): Promise<Pair> => ({ ...pair, base: tip() });
  return { root, git, bare, store, pair, target, exec, tip, readTarget, advance, newerHead };
}

test("base movement at the push boundary is rejected atomically by a real Git remote", async () => {
  const f = await fixture(); let pushes = 0;
  const exec: Exec = async (cmd, args) => {
    if (cmd === "git" && args.includes("push")) { pushes++; f.git("--git-dir", f.bare, "update-ref", "refs/heads/main", f.advance, f.pair.base); }
    return f.exec(cmd, args);
  };
  try {
    await expect(integratePair({ ...f, exec, now: Date.now }, f.target, f.pair, f.readTarget)).rejects.toThrow("base advanced at the push boundary");
    expect(pushes).toBe(1); expect(f.tip()).toBe(f.advance); expect(f.store.mergeAttempt(f.target.id)?.rejected).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a head move after the last lookup cannot add unreviewed content to the fixed candidate", async () => {
  const f = await fixture(); let moved = false;
  const exec: Exec = async (cmd, args) => { if (cmd === "git" && args.includes("push")) moved = true; return f.exec(cmd, args); };
  const readTarget = async (): Promise<Pair> => ({ ...f.pair, head: moved ? f.newerHead : f.pair.head, base: f.tip() });
  try {
    const result = await integratePair({ ...f, exec, now: Date.now }, f.target, f.pair, readTarget);
    expect(result).toStartWith("INTEGRATED_REVIEWED_PAIR"); expect(result).toContain("PR head advanced");
    const merged = f.tip(); expect(f.git("show", "-s", "--format=%P", merged)).toBe(`${f.pair.base} ${f.pair.head}`);
    expect(f.git("rev-parse", `${merged}^{tree}`)).toBe(f.git("rev-parse", `${f.pair.head}^{tree}`));
    expect((await f.exec("git", ["merge-base", "--is-ancestor", f.newerHead, merged])).code).toBe(1);
    expect(f.git("rev-parse", "HEAD")).toBe(f.newerHead); expect(f.git("status", "--porcelain")).toBe("");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a lost push response is reconciled from the saved candidate without a duplicate push", async () => {
  const f = await fixture(); let pushes = 0, lost = true;
  const fresh = join(f.root, "fresh-before-push");
  f.git("clone", "-q", "--no-local", join(f.root, "repo"), fresh);
  execFileSync("git", ["-C", fresh, "config", `url.${f.bare}.insteadOf`, "https://github.com/fixture/project.git"]);
  const exec: Exec = async (cmd, args) => {
    const r = await f.exec(cmd, args);
    if (cmd === "git" && args.includes("push")) { pushes++; if (lost) { lost = false; throw new Error("transport lost after server acceptance"); } }
    return r;
  };
  const readTarget = async (): Promise<Pair> => ({ ...f.pair, base: f.tip(), state: f.tip() === f.pair.base ? "OPEN" : "MERGED" });
  try {
    const d = { ...f, exec, now: Date.now };
    await expect(integratePair(d, f.target, f.pair, readTarget)).rejects.toThrow("transport lost");
    const prepared = f.store.mergeAttempt(f.target.id)!; expect(prepared.commit).toBe(f.tip());
    const freshExec: Exec = (cmd, args) => { if (cmd === "git" && args.includes("push")) pushes++; return spawnExec(cmd, cmd === "git" ? ["-C", fresh, ...args] : args); };
    expect(await recoverIntegration({ ...d, exec: freshExec }, f.target, await readTarget(), readTarget)).toStartWith("MERGED");
    expect(pushes).toBe(1); expect(f.store.mergeAttempt(f.target.id)?.commit).toBe(prepared.commit);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
