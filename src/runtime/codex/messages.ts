import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Deps } from "../../harness.ts";
import { takeManagedSubmit } from "./submit-lock.ts";
import { prepareBoundDone } from "./done-admission.ts";
import { Refusal } from "../../refusal.ts";
import type { SessionRef } from "../types.ts";
import { callBridgeTool, type BridgeScope } from "./bridge-tools.ts";
import { deliver } from "./delivery.ts";
import { MessageJournal } from "./message-journal.ts";
import { managementFinal, unseenTurns, type ManagementFinal } from "./message-schema.ts";
import { array, type CodexConnection, CodexError, object, text, type Notification } from "./protocol.ts";
import { assertEndpoint, type CodexStore } from "./store.ts";

export type ReconcileOutcome =
  | undefined
  | "inbox-busy"
  | { kind: "target-busy"; resource: "inbox" | "submit"; id: string };
/** Deterministic duty-owned dispatcher; reasoning and task tools remain in official Codex threads. */
export class MessageController {
  constructor(
    private readonly d: Deps,
    private readonly store: CodexStore,
    private readonly connection: CodexConnection,
  ) {
    if (realpathSync(d.store.root) !== realpathSync(store.root))
      throw new CodexError("ownership", "Controller home changed");
  }
  private async scope(ref: SessionRef): Promise<BridgeScope | undefined> {
    const entry = await this.store.owned(ref);
    if (!entry.envelope) return undefined;
    assertEndpoint(entry, this.connection.address);
    const role = entry.spec.role;
    if (role !== "lead" && role !== "lane" && role !== "duty") return undefined;
    const key = role === "lane" ? entry.spec.env["DORI_LANE"] || "" : "";
    const registered = role === "lane" ? this.d.store.lane(key)?.sessionRef : this.d.store.roles()[role];
    if (registered?.runtime !== "codex" || registered.id !== ref.id) return undefined;
    return {
      root: realpathSync(this.store.root),
      cwd: realpathSync(entry.spec.cwd),
      role,
      key,
      id: ref.id,
    };
  }
  private response(journal: MessageJournal, turn: Record<string, unknown>, final: ManagementFinal | undefined): void {
    const receipt = journal.receiptFor(text(turn["id"]));
    if (!receipt) return;
    const items = array(turn["items"]).map(object),
      users = items.filter((item) => item["type"] === "userMessage");
    const answer = items.findLast((item) => item["type"] === "agentMessage");
    const input = [{ type: "text", text: receipt.result, text_elements: [] }];
    if (
      turn["status"] !== "completed" ||
      turn["error"] != null ||
      users.length !== 1 ||
      users[0]?.["clientId"] !== receipt.client ||
      JSON.stringify(users[0]?.["content"]) !== JSON.stringify(input) ||
      answer?.["phase"] !== "final_answer" ||
      typeof answer["text"] !== "string"
    ) {
      journal.settle(receipt, "uncertain");
      journal.note("receipt/uncertain", {
        sourceTurn: receipt.turn.slice(0, 256),
        accepted: receipt.accepted.slice(0, 256),
        predicate: (() => {
          if (turn["status"] !== "completed") return "turn_status";
          if (turn["error"] != null) return "turn_error";
          if (users.length !== 1) return "user_count";
          if (users[0]?.["clientId"] !== receipt.client) return "client_id";
          if (JSON.stringify(users[0]?.["content"]) !== JSON.stringify(input)) return "input_content";
          if (answer?.["phase"] !== "final_answer") return "final_phase";
          return "text_type";
        })(),
        status:
          ["completed", "failed", "interrupted", "inProgress"].find((value) => value === turn["status"]) ?? "unknown",
        error: turn["error"] != null,
      });
      throw new CodexError("uncertain", "Canonical management receipt response changed");
    }
    journal.respond(receipt, final !== undefined);
    journal.note(final ? "receipt/continued" : "receipt/acknowledged", {
      turnId: turn["id"],
      sourceTurn: receipt.turn,
    });
  }
  async reconcile(ref: SessionRef, event?: Notification, historical?: ReadonlySet<string>): Promise<ReconcileOutcome> {
    if (this.d.store.stop("duty")) return;
    if (!(await this.scope(ref))) return; // Startup registration may commit after the first completed turn.
    let inbox = this.d.store.lockInbox(ref, Date.now());
    if (!inbox) return "inbox-busy";
    let release: (() => void) | undefined;
    try {
      if ((await this.store.owned(ref)).confirmed) return;
      release = takeManagedSubmit(this.store, ref.id);
      if (!release) return;
      const scope = await this.scope(ref),
        entry = await this.store.owned(ref);
      if (entry.confirmed) return;
      inbox();
      inbox = undefined;
      if (!scope || entry.desktopOwned || entry.uncertain) return;
      const thread = object(
        object(
          await this.connection.call("thread/read", {
            threadId: ref.id,
            includeTurns: false,
          }),
        )["thread"],
      );
      if (thread["id"] !== ref.id || realpathSync(text(thread["cwd"])) !== scope.cwd)
        throw new CodexError("ownership", "Controller thread identity changed");
      if (object(thread["status"])["type"] !== "idle") return;
      using journal = new MessageJournal(this.store, ref.id);
      journal.assertSettled();
      if (event)
        journal.note("completion/event", {
          method: event.method,
          turnId: event.params["turn"] ? object(event.params["turn"])["id"] : null,
        });
      for (const turn of await unseenTurns(this.connection, ref.id, (turn) => {
        const id = text(turn["id"]);
        if (!journal.seen(id)) return false;
        const old = journal.effect(id);
        if (old) {
          const final = managementFinal(ref.id, turn);
          if (!final || old.item !== final.source.itemId || old.body !== JSON.stringify(final.action))
            throw new CodexError("uncertain", "Previously reserved canonical source changed");
        }
        return true;
      })) {
        if (this.d.store.stop("duty")) return;
        journal.note("turn/observed", {
          turnId: turn["id"],
          status: turn["status"],
          error: turn["error"] != null,
          startedAt: turn["startedAt"],
          completedAt: turn["completedAt"],
          durationMs: turn["durationMs"],
        });
        let final: ManagementFinal | undefined;
        try {
          final = managementFinal(ref.id, turn);
        } catch (error) {
          const receipt = journal.receiptFor(text(turn["id"]));
          if (receipt) journal.settle(receipt, "uncertain");
          journal.observe(text(turn["id"]), "invalid-final");
          journal.note("source/refused", {
            turnId: turn["id"],
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        this.response(journal, turn, final);
        if (!final) {
          journal.observe(text(turn["id"]), "ordinary-or-failed");
          continue;
        }
        const currentScope = await this.scope(ref);
        if (this.d.store.stop("duty") || !currentScope) return;
        const done =
          final.action.tool === "dori_done"
            ? await prepareBoundDone({
                d: this.d,
                scope: currentScope,
                store: this.store,
                connection: this.connection,
                journal,
                final,
                event,
                historical,
              })
            : undefined;
        const prepared = done?.prepared;
        if (prepared?.kind === "deferred") return { kind: "target-busy", resource: prepared.resource, id: prepared.id };
        using admission = prepared?.kind === "prepared" ? prepared : undefined;
        if (this.d.store.stop("duty")) return;
        if (journal.reserve(final, done?.binding) !== "new") continue;
        try {
          // The existing role handler rechecks current durable registration and workspace itself.
          const result = admission
            ? await admission.execute()
            : await callBridgeTool(
                { ...this.d, lifecycleHooks: "disabled" },
                currentScope,
                final.action.tool,
                final.action.arguments,
              );
          journal.complete(final, result, currentScope.role === "lane" && final.action.tool === "dori_ready");
        } catch (error) {
          if (error instanceof Refusal) journal.complete(final, { error: error.message }, false, false);
          else {
            journal.uncertain(final, error);
            throw error;
          }
        }
      }
    } finally {
      release?.();
      inbox?.();
    }
    await this.drain(ref);
  }
  private async drain(ref: SessionRef): Promise<void> {
    if (this.d.store.stop("duty")) return;
    if (!(await this.scope(ref))) return;
    const entry = await this.store.owned(ref);
    if (this.d.store.stop("duty") || entry.desktopOwned || entry.uncertain) return;
    using journal = new MessageJournal(this.store, ref.id);
    journal.assertSettled();
    const row = journal.claim();
    if (!row) return;
    try {
      const source = { threadId: ref.id, turnId: row.turn, itemId: row.item };
      const bound = { source, action: row.body };
      const sent = await deliver(this.store, this.connection, ref, row.result, undefined, undefined, undefined, bound);
      switch (sent.kind) {
        case "delivered": {
          const accepted = journal.accepted(source);
          const hash = createHash("sha256")
            .update(JSON.stringify([{ type: "text", text: row.result, text_elements: [] }]))
            .digest("hex");
          if (!accepted || accepted.inputHash !== hash)
            throw new CodexError("uncertain", "Receipt acceptance identity missing");
          journal.settle(row, "delivered", accepted);
          break;
        }
        case "not-ready":
        case "no-agent":
          journal.settle(row, "queued");
          break;
        case "ambiguous":
        case "typed":
          journal.settle(row, "uncertain");
          break;
        default: {
          const never: never = sent;
          throw new CodexError("protocol", String(never));
        }
      }
    } catch (error) {
      journal.settle(row, "uncertain");
      throw error;
    }
  }
}
