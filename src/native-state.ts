import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Refusal } from "./refusal.ts";
import { record } from "./runtime/codex-transport.ts";
import { hasFullAccess, type NativePolicy } from "./runtime/codex-settings.ts";

export type NativeOwner = {
  readonly key: string;
  readonly name: string;
  readonly cwd: string;
  readonly socket: string;
  readonly model: string;
  readonly clientUserMessageId: string;
  readonly state: "pending" | "held" | "accepted";
  readonly threadId?: string;
  readonly modelProvider?: string;
  readonly queueId?: string;
  readonly promptHash?: string;
  readonly detail?: string;
  readonly archived?: true;
  readonly archiveState?: "pending" | "held";
  readonly creationConfirmed?: true;
  readonly completionTurnId?: string;
  readonly fullAccess?: boolean;
  readonly policy?: NativePolicy;
  readonly resumePolicy?: NativePolicy;
  /** Includes unresolved resume admission, even when bootstrap was accepted. */
  readonly policyHeld?: true;
};
export type CreatedOwner = NativeOwner & {
  readonly threadId: string;
  readonly modelProvider: string;
  readonly promptHash: string;
};

/** Current ownership/launch outcome, not a message queue or event journal. Reads never initialize the store. */
export class NativeState {
  private readonly root;
  constructor(home: string) {
    this.root = join(home, "native");
  }

  private path(key: string): string {
    const hash = createHash("sha256").update(key).digest("hex");
    return join(this.root, `launch-${hash}.json`);
  }

  private read(path: string): NativeOwner | undefined {
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Refusal(`invalid native ownership JSON ${path}`);
      throw error;
    }
    if (
      !record(raw) ||
      typeof raw["key"] !== "string" ||
      typeof raw["name"] !== "string" ||
      typeof raw["cwd"] !== "string" ||
      typeof raw["socket"] !== "string" ||
      typeof raw["model"] !== "string" ||
      typeof raw["clientUserMessageId"] !== "string"
    )
      throw new Refusal(`invalid native ownership record ${path}`);
    const state = raw["state"];
    if (state !== "pending" && state !== "held" && state !== "accepted")
      throw new Refusal(`invalid native launch state ${path}`);
    const optional: {
      threadId?: string;
      modelProvider?: string;
      queueId?: string;
      promptHash?: string;
      detail?: string;
      completionTurnId?: string;
    } = {};
    for (const key of ["threadId", "modelProvider", "queueId", "promptHash", "detail", "completionTurnId"] as const) {
      const value = raw[key];
      if (value !== undefined) {
        if (typeof value !== "string") throw new Refusal(`invalid native ${key} in ${path}`);
        optional[key] = value;
      }
    }
    const archiveState = raw["archiveState"];
    if (archiveState !== undefined && archiveState !== "pending" && archiveState !== "held")
      throw new Refusal(`invalid native archive state ${path}`);
    const policies: { policy?: NativePolicy; resumePolicy?: NativePolicy } = {};
    for (const key of ["policy", "resumePolicy"] as const) {
      const value = raw[key];
      if (value !== undefined) {
        if (!record(value)) throw new Refusal(`invalid native ${key} in ${path}`);
        policies[key] = value;
      }
    }
    const fullAccess = raw["fullAccess"];
    if (fullAccess !== undefined && typeof fullAccess !== "boolean")
      throw new Refusal(`invalid native fullAccess in ${path}`);
    return {
      key: raw["key"],
      name: raw["name"],
      cwd: raw["cwd"],
      socket: raw["socket"],
      model: raw["model"],
      clientUserMessageId: raw["clientUserMessageId"],
      state,
      ...optional,
      ...policies,
      ...(fullAccess === undefined ? {} : { fullAccess }),
      ...(raw["policyHeld"] === true ? { policyHeld: true } : {}),
      ...(archiveState === undefined ? {} : { archiveState }),
      ...(raw["archived"] === true ? { archived: true } : {}),
      ...(raw["creationConfirmed"] === true ? { creationConfirmed: true } : {}),
    };
  }

  launch(key: string): NativeOwner | undefined {
    return this.read(this.path(key));
  }

  owned(id: string): NativeOwner | undefined {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
    const index = this.read(join(this.root, `thread-${id}.json`));
    if (index?.threadId !== id) return undefined;
    const current = this.launch(index.key);
    return current?.threadId === id ? current : undefined;
  }

  launches(): NativeOwner[] {
    return existsSync(this.root)
      ? readdirSync(this.root)
          .filter((name) => name.startsWith("launch-") && name.endsWith(".json"))
          .flatMap((name) => {
            const owner = this.read(join(this.root, name));
            return owner ? [owner] : [];
          })
      : [];
  }

  /** Caller holds the OS-backed per-launch guard. The pending write precedes irreversible creation. */
  save(owner: NativeOwner): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const syncDirectory = (path: string) => {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    syncDirectory(dirname(this.root));
    const write = (path: string) => {
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(owner)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      syncDirectory(this.root);
    };
    write(this.path(owner.key));
    // Immutable creation lookup/provenance. Only the atomic launch record is current outcome authority.
    if (owner.threadId) {
      const index = join(this.root, `thread-${owner.threadId}.json`);
      if (!existsSync(index)) write(index);
    }
  }

  created(id: string, socket: string, fullAccess = false): CreatedOwner {
    const owner = this.owned(id);
    if (
      !owner?.creationConfirmed ||
      owner.socket !== socket ||
      owner.threadId === undefined ||
      !owner.modelProvider ||
      !owner.promptHash
    )
      throw new Refusal(`native thread ${id} is not confirmed owned and created in this home/endpoint`);
    if ((owner.fullAccess === true) !== fullAccess) throw new Refusal("native access mode changed; no reuse or resume");
    if (
      owner.policyHeld ||
      (fullAccess &&
        (!hasFullAccess(owner.policy) || (owner.resumePolicy !== undefined && !hasFullAccess(owner.resumePolicy))))
    )
      throw new Refusal("HELD native policy/resume admission was not confirmed");
    return { ...owner, threadId: owner.threadId, modelProvider: owner.modelProvider, promptHash: owner.promptHash };
  }

  confirmed(id: string, socket: string, fullAccess = false): CreatedOwner {
    const owner = this.created(id, socket, fullAccess);
    if (owner.state !== "accepted" || !owner.queueId)
      throw new Refusal(`native thread ${id} has an unconfirmed bootstrap outcome; HELD`);
    return owner;
  }
}
