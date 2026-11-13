import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Deps } from "../../harness.ts";
import { send } from "../../inbox.ts";
import { done, ready, report, startLane } from "../../lanes.ts";
import { Refusal } from "../../refusal.ts";
import { KEY_RE } from "../../store-types.ts";
import { argumentsOf, boundedText, bridgeTools, type BridgeRole } from "./bridge-schema.ts";
import { array, object, text } from "./protocol.ts";
import { CodexStore } from "./store.ts";
import { callAdapter } from "./bridge-adapter.ts";

export type BridgeScope = {
  readonly root: string;
  readonly cwd: string;
  readonly role: BridgeRole;
  readonly key: string;
  readonly id: string;
};
export const parseScope = (value: unknown): BridgeScope => {
  const data = object(value);
  const role = text(data["role"]);
  if (role !== "lead" && role !== "lane" && role !== "duty") throw new Refusal("Invalid bridge role");
  return { root: text(data["root"]), cwd: text(data["cwd"]), role, key: text(data["key"]), id: text(data["id"]) };
};

export const callBridgeTool = async (d: Deps, scope: BridgeScope, name: string, input: unknown): Promise<unknown> => {
  if (realpathSync(d.store.root) !== scope.root) throw new Refusal("Bridge instance mismatch");
  const owned = await new CodexStore(scope.root).owned({ runtime: "codex", id: scope.id });
  if (owned.spec.role !== scope.role || realpathSync(owned.spec.cwd) !== scope.cwd)
    throw new Refusal("Bridge session scope mismatch");
  const registered = scope.role === "lane" ? d.store.lane(scope.key)?.sessionRef : d.store.roles()[scope.role];
  if (registered?.runtime !== "codex" || registered.id !== scope.id)
    throw new Refusal("Bridge capability is no longer registered");
  if (name === "dori_job_status" || name === "dori_report_outcome") {
    if (scope.role !== "lead") throw new Refusal("Tool is not allowed for this role");
    return callAdapter(scope, name, input);
  }
  if (!bridgeTools(scope.role).some((tool) => tool.name === name))
    throw new Refusal("Tool is not allowed for this role");
  const laneKey = (value: unknown) => {
    const key = boundedText(value, 128);
    if (!KEY_RE.test(key)) throw new Refusal("Invalid lane key");
    return key;
  };
  const ownLane = (value: unknown) => {
    const key = laneKey(value);
    const lane = d.store.lane(key);
    if (lane?.sessionRef.runtime !== "codex" || realpathSync(lane.cwd) !== scope.cwd)
      throw new Refusal("Lane is outside this workspace");
    return key;
  };
  switch (name) {
    case "dori_status": {
      argumentsOf(input, []);
      return d.store
        .lanes()
        .filter((lane) => resolve(lane.cwd) === scope.cwd || resolve(lane.cwd) === resolve(owned.spec.cwd))
        .slice(-100)
        .map((lane) => ({
          key: lane.key,
          status: lane.status,
          final: lane.final,
        }));
    }
    case "dori_start": {
      const args = argumentsOf(input, ["key", "brief"]);
      const key = laneKey(args["key"]);
      const brief = boundedText(args["brief"]);
      const path = join(scope.root, `bridge-brief-${crypto.randomUUID()}.md`);
      writeFileSync(path, brief, { mode: 0o600, flag: "wx" });
      try {
        const lane = await startLane(d, key, path, { cwd: scope.cwd });
        return { key: lane.key, status: lane.status };
      } finally {
        rmSync(path);
      }
    }
    case "dori_send": {
      const args = argumentsOf(input, ["key", "text"]);
      return { delivery: await send(d, ownLane(args["key"]), boundedText(args["text"]), "lead") };
    }
    case "dori_done": {
      const args = argumentsOf(input, ["key"]);
      await done(d, ownLane(args["key"]));
      return { closed: true };
    }
    case "dori_report": {
      const args = argumentsOf(input, ["text", "status"]);
      const status = args["status"];
      if (status !== undefined && status !== "working" && status !== "waiting")
        throw new Refusal("Invalid report status");
      return {
        delivery: await report({ ...d, lifecycleHooks: "disabled" }, scope.key, boundedText(args["text"]), status),
      };
    }
    case "dori_ready": {
      const args = argumentsOf(input, ["text", "evidence"]);
      const evidence = array(args["evidence"]);
      if (evidence.length < 1 || evidence.length > 16) throw new Refusal("READY requires 1 to 16 evidence links");
      return {
        delivery: await ready(
          { ...d, lifecycleHooks: "disabled" },
          scope.key,
          boundedText(args["text"]),
          evidence.map((value) => boundedText(value, 2048)),
        ),
      };
    }
    default:
      throw new Refusal("Unknown management tool");
  }
};
