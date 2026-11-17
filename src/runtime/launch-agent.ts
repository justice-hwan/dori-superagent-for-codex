import { resolve } from "node:path";
import { shq } from "../delivery.ts";
import type { Deps } from "../harness.ts";
import { openSession, formatRef, type CreateSpec, type SessionRef } from "./types.ts";

/** Routing context, not unforgeable attestation or a sandbox boundary. */
export function nativeCommand(d: Deps, ref: SessionRef, model: string, lane?: string): string {
  const rt = d.runtimes.for(ref);
  if (rt.kind !== "codex") throw new Error("native command requires a native runtime");
  return (
    `DORI_RUNTIME=codex DORI_HOME=${shq(resolve(d.store.root))} DORI_SELF=${shq(formatRef(ref))} ` +
    `DORI_CODEX_SOCKET=${shq(rt.settings.socket)} DORI_CODEX_MODEL=${shq(model)} ` +
    `${lane ? `DORI_LANE=${shq(lane)} ` : ""}${shq(process.execPath)} ${shq(resolve(import.meta.dir, "../cli.ts"))}`
  );
}

/** The native branch receives rendered instructions; it never interprets a terminal command as a prompt. */
export async function launchAgent(
  d: Deps,
  spec: CreateSpec,
  key: string,
  render: (command: string, ref: SessionRef) => Promise<string>,
  terminalCommand: string,
): Promise<SessionRef> {
  const rt = d.runtimes.default;
  if (rt.kind !== "codex") return openSession(rt, spec, terminalCommand);
  return rt.launchAgent({ key, name: spec.name, cwd: spec.cwd }, (ref, model) =>
    render(nativeCommand(d, ref, model, spec.role === "lane" ? spec.name : undefined), ref),
  );
}
