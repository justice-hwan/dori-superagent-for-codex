import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, lstatSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type ReviewSnapshot = { cwd: string; diffPath: string; metadataPath: string; reportPath: string };

/** Freeze source and diff from immutable local objects, so a moving PR or working tree cannot change the review. */
export async function prepareReviewSnapshot(home: string, repo: string, pr: string, head: string, base: string): Promise<ReviewSnapshot> {
  if (![head, base].every((s) => /^[0-9a-f]{40}$/.test(s))) throw new Error("review needs full head and base SHAs");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  try { git("cat-file", "-e", `${head}^{commit}`); git("cat-file", "-e", `${base}^{commit}`); }
  catch { throw new Error("review requires a local clone containing both PR commits; fetch them before reviewing"); }
  mkdirSync(join(home, "reviews"), { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(home, "reviews", head.slice(0, 12) + "-")), cwd = join(root, "source");
  mkdirSync(cwd, { mode: 0o700 });
  // Read raw objects: git archive would honor export-ignore/export-subst and change the reviewed tree.
  const rawTree = git("ls-tree", "-rz", "--full-tree", head);
  const treeText = rawTree.toString("utf8");
  if (!Buffer.from(treeText).equals(rawTree)) throw new Error("review tree contains unsupported non-UTF8 paths");
  const records = treeText.split("\0").filter(Boolean);
  const entries = records.map((record) => {
    const tab = record.indexOf("\t"), [mode, type, oid] = record.slice(0, tab).split(" "), path = record.slice(tab + 1);
    if (tab < 0 || !oid || !["100644", "100755", "120000"].includes(mode!) || type !== "blob" || path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("review snapshot contains an unsupported or unsafe tree entry");
    return { mode, oid, path };
  });
  const paths = new Set(entries.map((e) => e.path));
  for (const { path } of entries) {
    for (let p = dirname(path); p !== "."; p = dirname(p)) if (paths.has(p)) throw new Error("review tree contains a file/symlink as a parent directory");
  }
  const links = new Map<string, string>();
  for (const { mode, oid, path } of entries) {
    if (mode !== "120000") continue;
    const blob = git("cat-file", "blob", oid), link = blob.toString("utf8");
    if (!Buffer.from(link).equals(blob) || !link || link.includes("\0") || isAbsolute(link)) throw new Error("review snapshot contains an unsupported or escaping symlink");
    links.set(path, link);
  }
  for (const [path, link] of links) {
    const parts = path.split("/").slice(0, -1), pending = link.split("/"); let expansions = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (!part || part === ".") continue;
      if (part === "..") { if (!parts.length) throw new Error("review snapshot symlink escapes frozen source"); parts.pop(); continue; }
      parts.push(part);
      const chained = links.get(parts.join("/"));
      if (chained !== undefined) {
        if (++expansions > 64) throw new Error("review snapshot contains a cyclic or excessive symlink chain");
        parts.pop(); pending.unshift(...chained.split("/"));
      }
    }
  }
  for (const { mode, oid, path } of entries) {
    const target = join(cwd, path);
    let parent = cwd;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      try { mkdirSync(parent, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      if (!lstatSync(parent).isDirectory()) throw new Error("review tree parent is not a real directory");
    }
    const blob = git("cat-file", "blob", oid);
    if (mode === "120000") symlinkSync(links.get(path)!, target);
    else writeFileSync(target, blob, { mode: mode === "100755" ? 0o700 : 0o600, flag: "wx" });
  }
  const diff = git("diff", "--no-ext-diff", "--no-textconv", "--binary", `${base}...${head}`);
  const diffPath = join(root, "diff.patch"), metadataPath = join(root, "metadata.json"), reportPath = join(root, "review.txt");
  writeFileSync(diffPath, diff, { mode: 0o600 });
  writeFileSync(metadataPath, JSON.stringify({ pr, head, base, sourceTree: git("rev-parse", `${head}^{tree}`).toString().trim(), diffSha256: createHash("sha256").update(diff).digest("hex") }, null, 2) + "\n", { mode: 0o600 });
  return { cwd, diffPath, metadataPath, reportPath };
}
