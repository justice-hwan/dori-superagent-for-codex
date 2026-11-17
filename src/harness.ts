import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { CodexRuntime } from "./runtime/codex.ts";
import { nativeSettings } from "./runtime/codex-settings.ts";
import { shq } from "./delivery.ts";
import { memFreePct } from "./host.ts";
import { type Exec, spawnExec } from "./runtime/exec.ts";
import { HcRuntime } from "./runtime/hc/index.ts";
import { HerdrRuntime } from "./runtime/herdr/index.ts";
import { Runtimes } from "./runtime/registry.ts";
import { RuntimeChoiceError, type RuntimeChoice, readRuntimeChoice } from "./runtime/select.ts";
import { Store } from "./store.ts";
import { type HostLoad, KEY_RE, type Role, reservedKey } from "./store-types.ts";
import { Telemetry, type Usage } from "./telemetry.ts";

export { KEY_RE, reservedKey };

const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");

export type Deps = {
  readonly store: Store;
  /** The session runtimes: `default` opens new sessions, `for(ref)` reaches a stored one on its own runtime. */
  readonly runtimes: Runtimes;
  /** Which runtime new sessions open on, and why (`dori status` prints it). Throws when none can be chosen. */
  readonly choice: () => RuntimeChoice;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
  readonly usage: Usage;
};

/** The runtime is chosen on first use, so commands that open or reach no session work without one installed. */
export const defaultDeps = (options: { readonly readOnly?: boolean } = {}): Deps => {
  const store = new Store(undefined, !options.readOnly);
  let chosen: RuntimeChoice | undefined;
  let runtimes: Runtimes | undefined;
  const choice = (): RuntimeChoice =>
    (chosen ??= readRuntimeChoice({ env: process.env, configPath: join(store.root, "config.json") }));
  return {
    store,
    get runtimes() {
      // The choice is made only when a NEW session is opened: a stored session's own runtime needs none.
      runtimes ??= new Runtimes(
        () => choice().kind,
        (k) => {
          switch (k) {
            case "hc":
              return new HcRuntime(spawnExec);
            case "herdr":
              return new HerdrRuntime(spawnExec, process.env["DORI_HERDR_SESSION"]);
            case "codex":
              return new CodexRuntime(store.root, nativeSettings(store.root, process.env));
            default: {
              const never: never = k;
              throw new Error(String(never));
            }
          }
        },
      );
      return runtimes;
    },
    choice,
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} bun ${shq(CLI)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    usage: new Telemetry(store.root, options.readOnly ? { ...process.env, DORI_TELEMETRY: "0" } : process.env),
  };
};

/** `DORI_PROMPTS_DIR` when set, else the repo's `prompts/`. */
export const promptsDir = (): string => process.env["DORI_PROMPTS_DIR"] || PROMPTS;

export const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(promptsDir(), name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

/** The roles `dori role` registers by hand; `dori up` also registers the two loop sessions. */
export const ROLES: readonly Role[] = ["lead", "duty"];

/** Legacy review/migration never required an installed terminal; only an explicitly selected native mode changes them. */
export function nativeMode(d: Deps): boolean {
  try {
    return d.choice().kind === "codex";
  } catch (error) {
    if (error instanceof RuntimeChoiceError) return false;
    throw error;
  }
}
