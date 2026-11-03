# Optional messenger transport

The baseline is [sisyphuslabs/dori-superagent at 90f02c1](https://github.com/sisyphuslabs/dori-superagent/tree/90f02c19fd86ce70cfd6a74f521c9acd24428cc3/skills/dori-mode/scripts/src/messenger). The messenger primitives were adapted from that upstream implementation under MIT. They use the same HTTP interfaces and preserve its routing and editing behavior without its former agent runtime.

Importing `src/messenger.ts` starts no listener, presence connection, polling loop or HTTP request. It reads no token, cookie, credential file or environment variable. The caller must explicitly enable a transport and inject configuration. Tests use fake HTTP and sockets; no live account was connected or messaged.

| Upstream behavior | Available in this fork |
| --- | --- |
| Slack channel/thread message and edit | `Slack.post`, `Slack.edit`, `sendMessenger` |
| Slack file delivery | `Slack.upload` external-upload flow |
| Slack own-thread, threads-view and unread discovery | `ThreadLedger`, `pollSlackInbound`; cursor commit belongs to caller after durable admission |
| Slack user presence | `slackPresence`, explicit `hold`/`release`; injected user token, cookie and socket opener |
| Telegram forum-topic delivery, edit, typing | `Telegram.send`, `edit`, `typing` |
| Telegram progressive reply | `startThinking`, throttled `streamDraft`, final persisted send |
| Telegram topic creation and state | `createTopic`, `renameTopic`, `closeTopic`, `reopenTopic` |
| Discord channel/thread delivery and edit | `Discord.send`, `edit`, `startThread`, `setThread` |
| Discord presence | `discordPresence` with injected gateway socket and timers |
| Typing during work | `typingWhile`, cleans its timer even when work fails |
| Voice transcription | `transcribe` with an explicitly configured argv hook and injected runner |

Presence is optional and does not start with Dori. Slack's user-client presence and thread-view/count endpoints are inherited upstream capabilities, not a guarantee that every bot token has access. Setup must select bot versus user account and the required scopes; login, app registration, gateway subscriptions and webhook verification remain explicit deployment work. Telegram/Discord inbound events come from an authenticated host integration such as the upstream agent-messenger setup; this module does not pretend that a normalized JSON envelope verifies a webhook signature.

## Delivery contract

`sendMessenger(input, http?, clock?)` takes `{enabled:true, platform, credential, cookie?, target, thread?, text, edit?}` and returns `{platform,target,thread?,messageId,edited}`. Platform is `slack`, `telegram` or `discord`. Slack's thread is `thread_ts`, Telegram's is a numeric forum topic, and Discord's is the channel ID of its existing thread. It does not open a new thread automatically. Existing platform classes expose topic/thread management separately.

`MessengerJournal(home)` stores private atomic state beneath `home/messenger`. Bind an **immutable native task/thread instance**, not a reusable lane key:

```ts
const journal = new MessengerJournal(home);
journal.bindTask(nativeTaskThreadId, {
  platform: "slack", account: "configured-account", workspace: "workspace-id",
  target: "channel-id", thread: "original-thread-ts", sourceMessage: "original-request-ts"
});
await journal.reply(nativeTaskThreadId, deliveryId, text, origin =>
  sendMessenger({ ...config, ...origin, text })
);
```

Journal origins require an explicit account identity and include platform, account, workspace, channel, thread/topic and original source message when supplied. Rebinding to another origin is refused; there is no fallback to a different channel or to the Codex conversation. A known receipt deduplicates an exact retry across restart. Changed content or destination under the same delivery ID is rejected. A crash, timeout, disconnect, malformed success or server error stays uncertain, and the same delivery is never blindly replayed. `reconcile(id, delivered, messageId?)` records a human-verified platform outcome. A confirmed rejection does not silently create another send attempt either.

The upstream rate-limit backoff is retained for HTTP 429. Non-idempotent writes are not retried on a 5xx or a lost response. Transport exceptions and API error bodies are not persisted or echoed, so Telegram token-bearing URLs and arbitrary remote error prose do not leak into receipts. Credentials are not saved in journal state. Discord edits and sends disable automatic mentions.

## Inbound contract

An authenticated host supplies an `InboundEnvelope` containing `id`, `origin`, `authorId`, `text` and optional `quoted`/`forwarded` flags. `acceptInbound(event,{ownerId,verify,task?})` calls the host verifier, checks the configured owner and task route (platform, account, workspace, channel and thread), persists the event, and returns `{duplicate,task?,event}`. A new follow-up may have a different source message ID on that same route; the task's original reply binding remains immutable. Quoted, forwarded and other people's messages are content rather than requests. This verifier callback is a trust boundary, not a replacement for platform authentication.

Keep the event unhandled until the task system has durably admitted the request. Retry dispatch using that persisted unhandled event after a crash; do not skip it merely because `duplicate` is true. Then call `markInboundHandled(platform,account,eventId,workspace?)`. Slack poll cursors similarly advance through `ThreadLedger.markSeen` **after** durable admission, so a crash between discovery and admission cannot discard the owner's message. Namespace each thread ledger with `{account,workspace}` when multiple accounts share its file.

Pages remains the owner-facing dashboard. Messenger adapters return a result to the request's recorded origin only after explicit connection setup; they do not mirror every lane update to every platform.
