import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnExec, type Exec } from "./process.ts";

/** Fetch and report upstream changes. Never merge, edit tracked files, commit or push. */
export async function checkUpstream(repo: string, exec: Exec = spawnExec) {
  const config = JSON.parse(readFileSync(join(repo, ".upstream.json"), "utf8")) as { repository: string; branch: string; integratedCommit: string };
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(config.branch) || !/^[a-f0-9]{40}$/.test(config.integratedCommit)) throw new Error("invalid upstream manifest");
  const git = async (...args: string[]) => {
    const r = await exec("git", ["-C", repo, ...args]);
    if (r.code) throw new Error(`upstream git ${args[0]} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const url = `https://github.com/${config.repository}.git`;
  const remote = await exec("git", ["-C", repo, "remote", "get-url", "upstream"]);
  if (remote.code) await git("remote", "add", "upstream", url);
  else if (![url, url.slice(0, -4), `git@github.com:${config.repository}.git`].includes(remote.stdout.trim())) throw new Error("upstream remote does not match .upstream.json; inspect it before fetching");
  await git("fetch", "--no-tags", "upstream", `refs/heads/${config.branch}:refs/remotes/upstream/${config.branch}`);
  const latest = await git("rev-parse", `refs/remotes/upstream/${config.branch}`);
  if (!/^[a-f0-9]{40}$/.test(latest)) throw new Error("upstream returned no full commit SHA");
  const ancestry = await exec("git", ["-C", repo, "merge-base", "--is-ancestor", config.integratedCommit, latest]);
  if (ancestry.code) throw new Error("upstream history is rewritten or the integrated commit is unavailable; inspect before integration");
  const pending = (await git("log", "--format=%H%x09%s", `${config.integratedCommit}..${latest}`)).split("\n").filter(Boolean).map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
  const history = await exec("git", ["-C", repo, "merge-base", "--is-ancestor", config.integratedCommit, "HEAD"]);
  return { repository: config.repository, branch: config.branch, integrated: config.integratedCommit, latest, pending, localHistoryPreserved: history.code === 0 };
}
