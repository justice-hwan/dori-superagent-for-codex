import type { Deps } from "../src/harness.ts";
import { CodexRuntime } from "../src/runtime/codex.ts";
import { nativeSettings } from "../src/runtime/codex-settings.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Store } from "../src/store.ts";
import { World } from "./fake.ts";
import type { nativeSetup } from "./native-setup.ts";

export function nativeDeps(f: ReturnType<typeof nativeSetup>, turnTimeoutMs?: number) {
  const w = new World();
  const settings = nativeSettings(f.home, f.env);
  const rt = new CodexRuntime(
    f.home,
    { ...settings, ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs }) },
    f.env,
  );
  const d: Deps = {
    store: new Store(f.home),
    runtimes: new Runtimes("codex", (kind) => {
      if (kind !== "codex") throw new Error(`Forbidden terminal runtime ${kind}`);
      return rt;
    }),
    choice: () => ({ kind: "codex", source: "config" }),
    exec: w.exec,
    now: () => w.clock,
    agentCmd: "FORBIDDEN-OMO",
    doriCmd: "dori",
    host: () => w.host,
    usage: w.recorder,
  };
  return { w, d, rt };
}
