---
name: dori-codex
description: Use when the user explicitly requests Dori for Codex, or asks to manage its local lead, duty, lane and review sessions.
---

# Dori for Codex

Use `dori-codex` from this repository. The runtime uses Codex app-server and keeps its own state under `~/.dori-codex` (or `DORI_HOME`).

1. Start the local runtime only when requested: `dori-codex up --cwd /absolute/project`.
2. Read `dori-codex status`. Talk to the lead with `dori-codex send lead --text '...'`, and read the response with `dori-codex read lead`.
3. For a task, write a concrete brief and use `dori-codex start <key> --brief FILE --cwd DIR`. Lanes report milestones and call `ready` with evidence. READY is a claim; inspect the evidence before `done`.
4. Send follow-ups using `send`. Busy or blocked threads keep messages in their inbox until they can receive them. Never treat a timeout as proof that input was not submitted.
5. Read pending requests with `dori-codex requests`. Only answer an approval or question with the user's explicit decision, via `requests answer ID --json FILE`. Do not grant permissions automatically.
6. Reviews require a CLEAR receipt for the exact head and base and green checks before `merge`. Never merge a changed head or base using an old receipt. Merge commits are the default, preserving upstream history.
7. `dori-codex interrupt TARGET` interrupts one owned turn; `dori-codex down` stops the local runtime and its owned work. It does not stop other Codex services or remote machines.
8. The hourly backlog loop is opt-in: `up --auto-loop` or `loop --once`. Do not add work the user did not authorize.

This package has no messaging connectors. Sending Slack, Notion, Kakao or other external messages requires a separately requested integration and authority.

Use `dori-codex upstream check` to fetch and list upstream changes. Integrate only on a dedicated branch, preserve Codex/communication boundaries, then test and review the exact final commit. Do not schedule automatic integration unless the user asks.
