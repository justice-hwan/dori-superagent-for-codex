import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareReviewSnapshot } from "../src/review-snapshot.ts";
import { mergeGate, review } from "../src/harness.ts";
import { World } from "./fake.ts";

test("review snapshot uses committed immutable source and diff despite dirty/newer working files", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-snapshot-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q"); writeFileSync(join(root, "sample.txt"), "base\n"); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "sample.txt"), "$Format:%s$\n"); writeFileSync(join(root, ".gitattributes"), "sample.txt export-subst\nignored.txt export-ignore\n"); writeFileSync(join(root, "ignored.txt"), "must be reviewed\n"); git("add", "."); git("commit", "-qm", "head"); const head = git("rev-parse", "HEAD");
    writeFileSync(join(root, "sample.txt"), "dirty-unreviewed\n");
    const snapshot = await prepareReviewSnapshot(join(root, "private-state"), root, "o/r#1", head, base);
    expect(readFileSync(join(snapshot.cwd, "sample.txt"), "utf8")).toBe("$Format:%s$\n");
    expect(readFileSync(join(snapshot.cwd, "ignored.txt"), "utf8")).toBe("must be reviewed\n");
    expect(readFileSync(snapshot.diffPath, "utf8")).toContain("+$Format:%s$");
    expect(readFileSync(snapshot.diffPath, "utf8")).not.toContain("dirty-unreviewed");
    expect(JSON.parse(readFileSync(snapshot.metadataPath, "utf8"))).toMatchObject({ head, base });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review writes no receipt if either head or base moves while the model reviews", async () => {
  for (const moving of ["head", "base", "branch"] as const) {
    const w = new World(), d = w.deps(); let reviewed = false;
    const initial = { headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), baseRefName: "main", state: "OPEN", isDraft: false };
    w.gh = () => ({ code: 0, stdout: JSON.stringify({ ...initial, ...(reviewed ? moving === "branch" ? { baseRefName: "release" } : { [moving === "head" ? "headRefOid" : "baseRefOid"]: "c".repeat(40) } : {}) }) });
    w.reviewer = () => { reviewed = true; return { code: 0, stdout: "VERDICT: CLEAR" }; };
    try {
      await expect(review(d, "o/r#1")).rejects.toThrow("changed during review");
      expect(d.store.receipt("o/r#1", initial.headRefOid)).toBeUndefined();
    } finally { rmSync(d.store.root, { recursive: true, force: true }); }
  }
});

test("merge rejects changed bases and failed check commands and preserves history by default", async () => {
  const w = new World(), d = w.deps(), head = "a".repeat(40); let base = "b".repeat(40), checkCode = 0;
  w.gh = (a) => a[1] === "view" ? { code: 0, stdout: JSON.stringify({ headRefOid: head, baseRefOid: base, baseRefName: "main", state: "OPEN", isDraft: false }) } : { code: checkCode, stdout: JSON.stringify([a[1]!.includes("check-runs") ? { check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] } : { statuses: [] }]) };
  try {
    await review(d, "o/r#1"); base = "c".repeat(40);
    await expect(mergeGate(d, "o/r#1")).rejects.toThrow("base changed");
    await review(d, "o/r#1"); checkCode = 1;
    await expect(mergeGate(d, "o/r#1")).rejects.toThrow("unconfirmed");
    checkCode = 0; await mergeGate(d, "o/r#1", { dryRun: true });
    await expect(mergeGate(d, "o/r#1", { method: "squash" })).rejects.toThrow("only merge commits");
  } finally { rmSync(d.store.root, { recursive: true, force: true }); }
});

test("CI is queried by captured SHA and a moved head cannot reach integration", async () => {
  const w = new World(), d = w.deps(), oldHead = "a".repeat(40), base = "b".repeat(40); let head = oldHead;
  w.gh = args => {
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: head, baseRefOid: base, baseRefName: "main", state: "OPEN", isDraft: false }) };
    head = "c".repeat(40);
    return { code: 0, stdout: JSON.stringify([args[1]!.includes("check-runs") ? { check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] } : { statuses: [] }]) };
  };
  try {
    await review(d, "o/r#1");
    await expect(mergeGate(d, "o/r#1")).rejects.toThrow("changed while checking");
    expect(w.calls.filter(c => c.cmd === "gh" && c.argv[0] === "api").every(c => c.argv[1]!.includes(oldHead))).toBe(true);
    expect(w.calls.some(c => c.cmd === "git")).toBe(false);
  } finally { rmSync(d.store.root, { recursive: true, force: true }); }
});

test("a historical confirmed integration cannot bypass a retargeted PR's new receipt", async () => {
  const w = new World(), d = w.deps(), head = "a".repeat(40), base = "b".repeat(40); let branch = "main";
  w.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: head, baseRefOid: base, baseRefName: branch, state: "OPEN", isDraft: false }) });
  try {
    await review(d, "o/r#1");
    d.store.saveMergeAttempt({ pr: "o/r#1", repo: "o/r", head, base, baseBranch: "main", tree: "c".repeat(40), commit: "d".repeat(40), confirmedAt: 1 });
    branch = "release";
    await expect(mergeGate(d, "o/r#1")).rejects.toThrow("base changed");
    expect(w.calls.some(c => c.cmd === "git")).toBe(false);
  } finally { rmSync(d.store.root, { recursive: true, force: true }); }
});

test("review snapshots reject absolute, relative and transitive symlink escapes, preserving contained links", async () => {
  const { symlinkSync } = await import("node:fs");
  for (const variant of ["absolute", "relative", "chained", "contained"] as const) {
    const root = mkdtempSync(join(tmpdir(), "dori-symlink-review-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init", "-q"); writeFileSync(join(root, "inside.txt"), "frozen marker\n"); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
      symlinkSync(variant === "absolute" ? "/tmp/unreviewed-source" : variant === "relative" ? "../../outside" : variant === "chained" ? "directory-link/../outside" : "inside.txt", join(root, "source.ts"));
      if (variant === "chained") symlinkSync(".", join(root, "directory-link"));
      git("add", "."); git("commit", "-qm", "links"); const head = git("rev-parse", "HEAD");
      if (variant === "contained") {
        const snapshot = await prepareReviewSnapshot(join(root, "state"), root, "o/r#1", head, base);
        expect(readFileSync(join(snapshot.cwd, "source.ts"), "utf8")).toBe("frozen marker\n");
      } else await expect(prepareReviewSnapshot(join(root, "state"), root, "o/r#1", head, base)).rejects.toThrow(/symlink/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
