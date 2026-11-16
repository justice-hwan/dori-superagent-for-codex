import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Refusal } from "../../refusal.ts";
import { trustedPath } from "./bridge-install.ts";
import { array, object, text } from "./protocol.ts";

const installed = new Map<string, Promise<string>>();

async function bundle(module: string, cwd: string): Promise<string> {
  const executable = trustedPath(process.execPath, cwd);
  const base = join(homedir(), ".local/share/dori/codex-bridge/adapters");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  trustedPath(base, cwd);
  const temporary = mkdtempSync(join(base, ".install-"));
  try {
    const output = join(temporary, "adapter.mjs");
    const manifest = join(temporary, "meta.json");
    // Compilation must not execute macros. Inspect the complete resolved graph
    // before importing its single bundle; opaque runtime imports are refused.
    const child = Bun.spawn(
      [
        executable,
        "build",
        module,
        "--target=bun",
        "--packages=bundle",
        "--reject-unresolved",
        "--no-macros",
        `--metafile=${manifest}`,
        `--outfile=${output}`,
      ],
      {
        env: process.env,
        cwd: dirname(module),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, , stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Refusal(`Adapter must have a fully bundled dependency graph: ${stderr}`);
    const metadata = object(JSON.parse(readFileSync(manifest, "utf8")));
    for (const input of Object.keys(object(metadata["inputs"]))) trustedPath(resolve(dirname(module), input), cwd);
    const outputs = object(metadata["outputs"]);
    if (Object.keys(outputs).length !== 1) throw new Refusal("Adapter must produce one executable bundle");
    const artifact = object(Object.values(outputs)[0]);
    if (
      array(artifact["imports"]).some((value) => {
        const path = text(object(value)["path"]);
        return !isBuiltin(path) && path !== "bun" && !path.startsWith("bun:");
      })
    )
      throw new Refusal("Adapter has unbundled executable dependencies");
    const bytes = readFileSync(output);
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const path = join(base, `${hash}.mjs`);
    chmodSync(output, 0o400);
    renameSync(output, path);
    return trustedPath(path, cwd);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** A bridge process imports only a frozen closure built from protected inputs. */
export const installAdapter = (module: string, cwd: string): Promise<string> => {
  const key = JSON.stringify([module, cwd]);
  const cached = installed.get(key);
  if (cached) return cached;
  const result = bundle(module, cwd);
  installed.set(key, result);
  return result;
};
