import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUpstream } from "../src/upstream.ts";
import type { Exec } from "../src/process.ts";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dori-upstream-test-")), integrated = "a".repeat(40), latest = "b".repeat(40);
  writeFileSync(join(root, ".upstream.json"), JSON.stringify({ repository: "sisyphuslabs/dori-superagent", branch: "main", integratedCommit: integrated }));
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, argv) => {
    const a = argv.slice(2); calls.push([...a]);
    const stdout = a[0] === "remote" ? "https://github.com/sisyphuslabs/dori-superagent.git\n" : a[0] === "rev-parse" ? latest : a[0] === "log" ? `${latest}\tupstream fix\n` : "";
    return { code: 0, stdout, stderr: "" };
  };
  return { root, integrated, latest, calls, exec };
}
test("upstream check fetches/list changes while leaving integration for a separate reviewed branch", async () => {
  const f = fixture(); try {
    const r = await checkUpstream(f.root, f.exec);
    expect(r).toMatchObject({ integrated: f.integrated, latest: f.latest, localHistoryPreserved: true, pending: [{ sha: f.latest, subject: "upstream fix" }] });
    expect(f.calls.some((a) => a[0] === "fetch")).toBe(true);
    expect(f.calls.some((a) => ["merge", "pull", "push", "commit"].includes(a[0]!))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test("mismatched remotes and rewritten upstream history fail closed", async () => {
  for (const scenario of ["remote", "history"]) {
    const f = fixture(); try {
      const exec: Exec = async (cmd, args) => {
        if (scenario === "remote" && args[2] === "remote") return { code: 0, stdout: "https://github.com/unexpected/repo.git", stderr: "" };
        if (scenario === "history" && args[2] === "merge-base") return { code: 1, stdout: "", stderr: "" };
        return f.exec(cmd, args);
      };
      await expect(checkUpstream(f.root, exec)).rejects.toThrow(scenario === "remote" ? "does not match" : "rewritten");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
