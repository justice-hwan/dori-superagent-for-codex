import type { Store, PreparedMerge } from "./store.ts";
import type { Exec } from "./process.ts";

export type Pair = { head: string; base: string; baseBranch: string; state: string; draft: boolean };
type Context = { store: Store; exec: Exec; now: () => number };
type Target = { id: string; repo: string };
const SHA = /^[0-9a-f]{40}$/;
const auth = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
const remote = (repo: string) => `https://github.com/${repo}.git`;

async function git(d: Context, args: string[]): Promise<string> {
  const r = await d.exec("git", args);
  if (r.code) throw new Error(`MERGE_REFUSED git ${args[0]} failed; inspect the repository and prepared merge`);
  return r.stdout.trim();
}

async function verifyCandidate(d: Context, a: PreparedMerge): Promise<void> {
  if (![a.head, a.base, a.tree, a.commit].every((s) => SHA.test(s))) throw new Error("MERGE_REFUSED invalid prepared object id");
  await git(d, ["check-ref-format", `refs/heads/${a.baseBranch}`]);
  const tree = (await git(d, ["merge-tree", "--write-tree", a.base, a.head])).split("\n")[0];
  const actual = (await git(d, ["show", "-s", "--format=%T%n%P", a.commit])).split("\n");
  if (tree !== a.tree || actual[0] !== tree || actual[1] !== `${a.base} ${a.head}`) throw new Error("MERGE_REFUSED prepared merge is not the reviewed pair's merge tree and parents");
}

async function onRemote(d: Context, a: PreparedMerge): Promise<{ integrated: boolean; tip: string }> {
  const line = await git(d, [...auth, "ls-remote", remote(a.repo), `refs/heads/${a.baseBranch}`]);
  const rows = line.split("\n").filter(Boolean);
  const [tip, ref] = rows[0]?.split(/\s+/) ?? [];
  if (rows.length !== 1 || !tip || !SHA.test(tip) || ref !== `refs/heads/${a.baseBranch}`) throw new Error("MERGE_UNCONFIRMED remote base was not resolved");
  await git(d, [...auth, "fetch", "--no-tags", "--no-write-fetch-head", remote(a.repo), tip]);
  if (tip === a.commit) return { integrated: true, tip };
  const ancestry = await d.exec("git", ["merge-base", "--is-ancestor", a.commit, tip]);
  if (ancestry.code !== 0 && ancestry.code !== 1) throw new Error("MERGE_UNCONFIRMED remote ancestry could not be checked");
  return { integrated: ancestry.code === 0, tip };
}

async function report(d: Context, a: PreparedMerge, readTarget: () => Promise<Pair>): Promise<string> {
  a.confirmedAt = d.now(); d.store.saveMergeAttempt(a);
  let current: Pair | undefined;
  try { current = await readTarget(); } catch { /* Integration is verified separately from PR metadata. */ }
  const label = current?.state === "MERGED" && current.head === a.head && current.baseBranch === a.baseBranch ? "MERGED" : "INTEGRATED_REVIEWED_PAIR";
  return `${label} ${a.pr} head=${a.head} base=${a.base} branch=${a.baseBranch} commit=${a.commit} prState=${current?.state ?? "unconfirmed"}${current && current.head !== a.head ? " (PR head advanced; newer work remains separate)" : ""}${current && current.baseBranch !== a.baseBranch ? " (PR target changed; this integration belongs to the recorded branch)" : ""}`;
}

/** Reconcile a previous push before issuing another one. Never manufacture a second candidate after a lost response. */
export async function recoverIntegration(d: Context, target: Target, pair: Pair, readTarget: () => Promise<Pair>): Promise<string | undefined> {
  const a = d.store.mergeAttempt(target.id);
  if (!a || a.rejected || (a.confirmedAt && (a.head !== pair.head || a.baseBranch !== pair.baseBranch))) return;
  if (a.pr !== target.id || a.repo !== target.repo) throw new Error("MERGE_REFUSED prepared repository mismatch");
  if (![a.head, a.base, a.tree, a.commit].every(s => SHA.test(s))) throw new Error("MERGE_REFUSED invalid prepared object id");
  await git(d, ["check-ref-format", `refs/heads/${a.baseBranch}`]);
  const seen = await onRemote(d, a);
  if (seen.integrated) { await verifyCandidate(d, a); return report(d, a, readTarget); }
  if (a.confirmedAt) throw new Error("MERGE_UNCONFIRMED previously integrated commit is no longer on the remote base; inspect history");
  if (pair.head !== a.head || pair.base !== a.base || pair.baseBranch !== a.baseBranch || seen.tip !== a.base) {
    a.rejected = true; d.store.saveMergeAttempt(a);
    throw new Error("MERGE_REFUSED head or base changed before the prepared merge was integrated; review the new pair");
  }
}

/** The only pushed commit is a fixed merge of reviewed objects. The remote base is updated with an exact expected-value lease. */
export async function integratePair(d: Context, target: Target, pair: Pair, readTarget: () => Promise<Pair>): Promise<string> {
  await git(d, ["check-ref-format", `refs/heads/${pair.baseBranch}`]);
  let a = d.store.mergeAttempt(target.id);
  if (!a || a.rejected || a.head !== pair.head || a.base !== pair.base || a.baseBranch !== pair.baseBranch) {
    const tree = (await git(d, ["merge-tree", "--write-tree", pair.base, pair.head])).split("\n")[0]!;
    if (!SHA.test(tree)) throw new Error("MERGE_REFUSED no conflict-free merge tree");
    const commit = await git(d, ["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", pair.base, "-p", pair.head, "-m", `Merge reviewed ${target.id}\n\nhead ${pair.head}\nbase ${pair.base}`]);
    a = { pr: target.id, repo: target.repo, baseBranch: pair.baseBranch, head: pair.head, base: pair.base, tree, commit };
    await verifyCandidate(d, a);
    d.store.saveMergeAttempt(a); // Write ahead of the external push.
  } else await verifyCandidate(d, a);
  const current = await readTarget();
  if (current.head !== pair.head || current.base !== pair.base || current.baseBranch !== pair.baseBranch || current.state !== "OPEN" || current.draft) throw new Error("MERGE_REFUSED head, base or PR state changed before push");
  const push = await d.exec("git", [...auth, "push", "--porcelain", `--force-with-lease=refs/heads/${pair.baseBranch}:${pair.base}`, remote(target.repo), `${a.commit}:refs/heads/${pair.baseBranch}`]);
  let seen: Awaited<ReturnType<typeof onRemote>>;
  try { seen = await onRemote(d, a); }
  catch { throw new Error(`MERGE_UNCONFIRMED prepared commit=${a.commit}; inspect or retry this command to reconcile, without rebuilding`); }
  if (!seen.integrated) {
    if (seen.tip !== pair.base) { a.rejected = true; d.store.saveMergeAttempt(a); throw new Error("MERGE_REFUSED base advanced at the push boundary; reviewed commit was not integrated"); }
    throw new Error(`MERGE_NOT_INTEGRATED commit=${a.commit}; push ${push.code === 0 ? "returned success but remote verification disagreed" : "was rejected or failed"}; retry reuses this prepared commit`);
  }
  return report(d, a, readTarget);
}
