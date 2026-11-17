import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import type { NativeOwner, NativeState } from "../native-state.ts";
import { Refusal } from "../refusal.ts";
import { selectedNativeThread } from "./codex-io.ts";
import { NativeIoError, record, type NativeConnection } from "./codex-transport.ts";
import { hasFullAccess, nativePolicy } from "./codex-settings.ts";

/** Only a confirmed same-mode owner may reassert its admitted full-access contract on resume. */
export async function ensureNativeLoaded(
  connection: NativeConnection,
  owner: NativeOwner & { threadId: string },
  state: NativeState,
) {
  const target = { threadId: owner.threadId, cwd: owner.cwd };
  const metadata = await selectedNativeThread(connection, target);
  if (metadata.status !== "notLoaded") return metadata;
  // Resume can load the thread before its response is validated or even received.
  state.save({ ...owner, policyHeld: true });
  const resumed = await connection.request("thread/resume", {
    threadId: owner.threadId,
    excludeTurns: true,
    ...(owner.fullAccess ? { sandbox: "danger-full-access", approvalPolicy: "never" } : {}),
  });
  const thread = record(resumed) ? resumed["thread"] : undefined;
  if (
    !record(resumed) ||
    !record(thread) ||
    thread["id"] !== owner.threadId ||
    typeof resumed["cwd"] !== "string" ||
    realpathSync(resumed["cwd"]) !== realpathSync(owner.cwd) ||
    resumed["model"] !== owner.model ||
    resumed["modelProvider"] !== owner.modelProvider
  )
    throw new Refusal("owned native resume identity/model/provider changed; no input sent");
  const policy = nativePolicy(resumed);
  const policyHeld = owner.fullAccess === true && !hasFullAccess(policy);
  state.save({ ...owner, resumePolicy: policy, ...(policyHeld ? { policyHeld: true } : {}) });
  if (policyHeld) throw new Refusal("HELD native full-access resume policy/approval was not admitted");
  return selectedNativeThread(connection, target);
}

/** rust-v0.167.2 paging: at most four 50-item pages, 65536 text code units and 500 logical lines. */
export async function nativeItems(
  connection: NativeConnection,
  threadId: string,
  options: {
    lines: number;
    review?: { turnId: string; clientUserMessageId: string; promptHash: string };
  },
): Promise<{ text: string; truncated: boolean; matchesInput: boolean }> {
  const { lines, review } = options;
  const turnId = review?.turnId;
  let matchesInput = review === undefined;
  if (!Number.isInteger(lines) || lines < 1 || lines > 500) throw new Refusal("native read requires 1-500 lines");
  const texts: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let truncated = false;
  let characters = 0;
  let count = 0;
  for (let page = 0; page < 4; page++) {
    const response = await connection.request("thread/items/list", {
      threadId,
      ...(turnId === undefined ? {} : { turnId }),
      cursor,
      limit: 50,
      sortDirection: "desc",
    });
    if (
      !record(response) ||
      !Array.isArray(response["data"]) ||
      !(response["nextCursor"] === null || typeof response["nextCursor"] === "string")
    )
      throw new NativeIoError("protocol", "Native item page changed");
    for (const [index, entry] of response["data"].entries()) {
      if (
        !record(entry) ||
        typeof entry["turnId"] !== "string" ||
        !record(entry["item"]) ||
        (turnId !== undefined && entry["turnId"] !== turnId)
      )
        throw new NativeIoError("identity", "Native item turn identity changed");
      const item = entry["item"];
      if (typeof item["type"] !== "string") throw new NativeIoError("protocol", "Native item type changed");
      let text: string;
      switch (item["type"]) {
        case "agentMessage":
          if (typeof item["text"] !== "string") throw new NativeIoError("protocol", "Native agent text changed");
          text = item["text"];
          break;
        case "userMessage":
          if (!Array.isArray(item["content"])) throw new NativeIoError("protocol", "Native user input changed");
          if (review) {
            const input: unknown = item["content"][0];
            matchesInput ||=
              item["clientId"] === review.clientUserMessageId &&
              item["content"].length === 1 &&
              record(input) &&
              input["type"] === "text" &&
              typeof input["text"] === "string" &&
              createHash("sha256").update(input["text"]).digest("hex") === review.promptHash;
            continue;
          }
          text = item["content"]
            .flatMap((part: unknown) =>
              record(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : [],
            )
            .join("\n");
          break;
        default:
          if (review) continue;
          text = `[${String(item["type"])}]`;
      }
      if (text.length > 65536 - characters) {
        text = text.slice(-(65536 - characters));
        truncated = true;
      }
      texts.push(text);
      characters += text.length;
      count += text.split("\n").length;
      if (characters >= 65536 || count >= lines) {
        truncated ||= index + 1 < response["data"].length;
        break;
      }
    }
    cursor = response["nextCursor"];
    if (cursor === null) break;
    if (cursors.has(cursor)) throw new NativeIoError("protocol", "Native item cursor repeated");
    cursors.add(cursor);
    if (count >= lines || characters >= 65536) break;
  }
  const all = texts.reverse().join("\n").split("\n");
  truncated ||= cursor !== null || all.length > lines;
  return { text: all.slice(-lines).join("\n"), truncated, matchesInput };
}
