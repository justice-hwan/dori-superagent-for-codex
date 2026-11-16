import { renameSync, writeFileSync } from "node:fs";
import { takeInboxLock } from "../../inbox-lock.ts";
import type { CodexStore } from "./store.ts";

/** A release hint never grants admission or changes the result of an already executed operation. */
export function takeManagedSubmit(
  store: CodexStore,
  id: string,
  options: { readonly reservationAuthoritative?: boolean } = {},
): (() => void) | undefined {
  const release = takeInboxLock(`${store.path(id)}.submit-lock`, Date.now(), options);
  if (!release || id.startsWith("worker-")) return release;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    release();
    const marker = `${store.path(id)}.submit-released`;
    const generation = crypto.randomUUID();
    const temporary = `${marker}.${generation}.tmp`;
    try {
      writeFileSync(temporary, generation, { mode: 0o600, flag: "wx" });
      renameSync(temporary, marker);
    } catch (error) {
      // Deferred source bindings stay durable and unconsumed. Do not turn accepted work into a retry.
      process.stderr.write(`dori: Codex submit release hint failed for ${id}: ${String(error)}\n`);
    }
  };
}
