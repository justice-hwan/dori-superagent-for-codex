---
name: dori-codex
description: Use when the user explicitly requests Dori for Codex, or asks to manage its local lead, duty, lane and review sessions.
---

# Dori for Codex

Use `dori-codex` from this repository. The runtime uses Codex app-server and keeps its own state under `~/.dori-codex` (or `DORI_HOME`).

1. Start the local runtime only when requested: `dori-codex up --cwd /absolute/project`.
   For an authorized existing local server/chat, use a separate `DORI_HOME` and `up --connect ws+unix:///absolute/socket --lead THREAD`. The chat must already be loaded; no replacement or force bypass. Settings persist per home. A running connection mismatch refuses. Shared mode uses this external lead and code duty, without synthetic model role threads. New owned workers use `🐾dori/{topic}` titles when supported; preserve the existing lead title.
2. Read `dori-codex status`. Talk to the lead with `dori-codex send lead --text '...'`, and read the response with `dori-codex read lead`.
3. For a task, write a concrete brief and use `dori-codex start <key> --brief FILE --cwd DIR`. Lanes report milestones and call `ready` with evidence. READY is a claim; inspect the evidence before `done`.
4. Send follow-ups using `send`. Busy workers and blocked threads keep messages queued. An active unblocked external lead receives a steer against its refreshed native turn ID; an idle lead receives a new turn. Never treat a timeout/disconnect as proof that input was not submitted. Inspect native history before explicitly reconciling uncertainty; do not blindly replay.
5. Read owned-worker pending requests with `dori-codex requests`. Only answer an approval or question with the user's explicit decision, via `requests answer ID --json FILE`. Do not grant permissions automatically. External/unrelated requests stay with the native app and must never be answered or rejected by Dori.
6. Reviews require a CLEAR receipt for the exact repository, head, base and base branch, plus green checks at that head. `merge` prepares only those reviewed objects and advances the base with an exact expected-value lease. A changed base rejects the push. A newer PR head stays outside the fixed candidate; report pair integration separately until GitHub confirms the PR merged. Never close newer work or bypass a rejection. Only merge commits are supported, preserving upstream history. After an uncertain response, retry the same command to verify its saved candidate before another push.
7. `dori-codex interrupt TARGET` interrupts one owned turn; `dori-codex down` stops the local runtime and its owned work. The external lead is protected against interruption, close and archive. Shared turn creation requires the first user message's matching `clientId`; `turn/start` can otherwise steer a native turn. Native-created turns' requests stay native. Shared shutdown closes admission, drains submissions, confirms targets interrupted or already terminal, disconnects only this client and preserves unrelated work. Unconfirmed creation or cleanup retains runtime ownership. Never restart, signal or shut down a shared server. For rollback, stop this Dori home, then return to the retained owned-mode home (or `up --owned` in a fresh home). Do not change a live home's connection settings. Offline fixtures are separate from live validation.
8. The hourly backlog loop is opt-in: `up --auto-loop` or `loop --once`. Do not add work the user did not authorize.

Shared mode never calls `thread/archive`: closing a worker retires only its local Dori registration after existing operation/state checks, and shared review chats remain open in Codex after collection. A final idle check cannot make archival safe against native admission because archive has no expected-turn precondition. Owned stdio close/review archival remains unchanged.

This package has no messaging connectors. Sending Slack, Notion, Kakao or other external messages requires a separately requested integration and authority.

Use `dori-codex upstream check` to fetch and list upstream changes. Integrate only on a dedicated branch, preserve Codex/communication boundaries, then test and review the exact final commit. Do not schedule automatic integration unless the user asks.
