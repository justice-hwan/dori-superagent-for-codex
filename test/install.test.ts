import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const script = resolve(import.meta.dir, "../install.sh");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "dori-install-")); roots.push(root);
  const src = join(root, "src"), home = join(root, "home"), bin = join(root, "bin"), calls = join(root, "calls");
  mkdirSync(join(src, "skills/dori-codex"), { recursive: true }); mkdirSync(home); mkdirSync(bin);
  for (const tool of ["bun", "codex", "git"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' '${tool}' \"$@\" >> '${calls}'\nexit 0\n`); chmodSync(join(bin, tool), 0o755);
  }
  const run = () => Bun.spawnSync(["/bin/bash", script], { env: { ...process.env, HOME: home, DORI_SRC: src, SKILLS_DIR: join(home, "skills"), PATH: `${bin}:/usr/bin:/bin` } });
  return { src, home, calls, run };
}

test("installation links only the reviewed Codex skill and uses frozen dependencies", () => {
  const { src, home, calls, run } = setup(); expect(run().exitCode).toBe(0);
  expect(readlinkSync(join(home, "skills/dori-codex"))).toBe(join(src, "skills/dori-codex"));
  expect(readlinkSync(join(home, ".local/bin/dori-codex"))).toBe(join(src, "src/cli.ts"));
  const commands = readFileSync(calls, "utf8");
  expect(commands).toContain("--frozen-lockfile"); expect(commands).toContain("--ignore-scripts");
  expect(commands).not.toContain("git"); expect(commands).not.toContain("up");
  expect(existsSync(join(home, ".dori"))).toBe(false);
});

test("a pre-existing user skill is preserved", () => {
  const { home, run } = setup(); const skill = join(home, "skills/dori-codex"); mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "mine"), "preserve"); expect(run().exitCode).toBe(0);
  expect(readFileSync(join(skill, "mine"), "utf8")).toBe("preserve");
});
