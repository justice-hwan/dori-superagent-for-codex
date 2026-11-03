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

Presence helpers are optional and do not start with Dori. Slack's user-client presence and thread-view/count endpoints are inherited upstream capabilities, not a guarantee that every bot token has access. Setup must select bot versus user account and the required scopes. The explicit runners below consume authenticated provider HTTP/gateway events directly; there is no public normalized-JSON ingress or webhook listener.

## Explicit inbound service

An already running Dori home must have distinct `conversation` and internal `lead` roles (`up --split`). These commands do not start, stop or reconfigure the Codex server. Generate a disabled template, privately enter credentials and IDs, then explicitly enable only the connector you intend to operate:

```sh
dori-codex messenger config example telegram > /private/path/telegram.json
chmod 600 /private/path/telegram.json
# Edit the file locally; set enabled:true after account/app setup and authorization.
dori-codex messenger config check --config /private/path/telegram.json
dori-codex messenger start --config /private/path/telegram.json
```

`start` is a foreground service. Keep that process running in your own terminal or process supervisor. It verifies the configured authenticated account, receives allowlisted owner messages, admits them to the registered work lead/task ledger, and automatically sends committed task-completion notices only to their immutable captured origins. The user does not call an admission API or a reply command for each message. The work lead still creates the task: it receives an already-written private origin file and must use `start KEY --brief FILE --origin FILE` before kickoff. Raw lane reports stay internal and Pages remains the dashboard.

```sh
dori-codex messenger status
dori-codex messenger stop RUNNER_ID
dori-codex messenger status    # confirm state: stopped
```

Stop is a durable request for the exact runner nonce. It aborts provider HTTP, closes owned gateway sockets and timers, drains admitted work, then releases the account lease. SIGINT/SIGTERM also stop this foreground service. No PID signal is sent to another process. Status is a saved observation with `at`, not proof that a crashed process is alive; explicit restart recovers a stale account lease and cursors. A prior run's stop request cannot stop a new run. One runner per platform/account/workspace prevents competing cursor writers. A saved owner/target allowlist cannot be changed against old cursors: use an isolated home for a different connector scope.

The explicit JSON has `enabled`, `platform`, `credential`, `account` (the authenticated bot/user ID, not the owner's ID), `ownerId`, `targets` (exact chat/channel IDs), and optionally `intervalMs` (250–60000, default 2000). Slack/Discord additionally require `workspace` (team/guild ID). Slack requires `since`, an explicit initial timestamp such as `1790000000.000000`; Discord requires `after`, an object mapping every target to its initial message ID (`"0"` reads all accessible history). Durable cursors take precedence on restart. Slack alone accepts optional `cookie` and `upstreamDiscovery:true`. Configuration validation performs no provider calls, and errors never print credentials. There is no environment-token, keychain, config search or credential-file discovery fallback. Missing/disabled config and ordinary `up` do not read a connector credential or perform provider IO.

| Connector | Startable after explicit setup | Registration and permissions | Restart and limits | Evidence |
| --- | --- | --- | --- | --- |
| Telegram | Bot token, bot `account`, numeric owner ID and chat allowlist | Create a bot with BotFather; allow it to receive owner messages in the chosen chat/topic (group privacy settings affect delivery); permit sending there | `getMe` identity and `getWebhookInfo` check; existing webhook is refused, never deleted. `getUpdates` offset commits only after durable admission/explicit rejection. Only one poller may use the token. Provider pending-update retention still applies | Injected Bot API HTTP; forum-topic E2E. No live bot activation |
| Slack | User OAuth token (optional explicitly supplied cookie), authenticated member ID, team ID, channels, initial `since` | Install/authorize an app with `chat:write` and history scopes for selected conversation types (`channels:history`, `groups:history`, `im:history`, `mpim:history` as needed); account must belong to targets. User token is needed for channel thread replies; bot-token support depends on conversation type/API access | `auth.test` identity/team check; paginated history + durable watched-thread replies. Explicit `upstreamDiscovery:true` additionally uses upstream private thread-view/count APIs, which may be unavailable. Read failures retain cursors. API rate limits can make catch-up slow | Injected Web API HTTP, pagination, watched threads and upstream discovery fixtures. No live workspace proof |
| Discord | Bot token, bot/owner IDs, guild ID, explicit text-channel or existing thread IDs, `after` cursors | Register bot/app, invite to guild; enable Message Content privileged intent; permit View Channel, Read Message History, Send Messages (and Send Messages in Threads where applicable). Targets must be supported message channels in the configured guild | Verify bot and target guild via REST; gateway Identify/Resume with durable sequence, heartbeat watchdog/reconnect. REST history catch-up runs before initial connection and each cycle, including after invalid resume. Complete history snapshot precedes cursor commit; deleted/inaccessible history cannot be recovered. No automatic thread discovery or DM runner | Injected REST + gateway socket/events, resume and missed-history recovery. No live gateway proof |

Owner text only is admitted. Bot/webhook, unauthorized, forwarded/quoted, edited and empty/unsupported messages are ignored; media transcription and file upload remain explicit primitives rather than automatic execution. Telegram forum topics and Slack root threads remain distinct routes. Discord threads are channels and must be listed explicitly. On an unambiguous route with one open bound task, a follow-up pivots that exact native instance; ambiguous routes remain unconfirmed without cursor advance. A persisted event keeps its original task instance even if a lane key is reused. New requests arriving before task allocation stay work-lead requests; the lead checks existing origins before creating work.

Automatic delivery requires a committed exact instance/revision completion receipt from lead `done`; `READY` alone never sends. The runner recovers the ledger-to-outbox gap and uses the existing journal's immutable route and stable delivery ID. Unknown/rejected sends appear in `blockedDeliveries` and are not blindly replayed. Inspect provider history before using existing `messenger reconcile`; a verified delivered message can then commit its outbox receipt on the next cycle. There is no automatic retry of an explicitly rejected send. A blocked inbound event cannot stop unrelated committed outbound completion delivery.

## Upstream adaptation record

Inspected commit: `90f02c19fd86ce70cfd6a74f521c9acd24428cc3`, available in the captured repository objects. A current network fetch was blocked by the execution sandbox, so this is a pinned baseline, not a claim about today's upstream head.

* `skills/dori-mode/scripts/src/cli.ts`: Slack `inbound` polling, explicit send/presence/transcribe commands. Reused its platform clients, polling and heartbeat behavior; inbound now feeds the Codex harness rather than printing lines for another agent runtime.
* `scripts/src/messenger/{slack-inbound,thread-ledger,slack-presence,slack,telegram,discord,http,typing,voice}.ts` under that skill: preserved public primitives and their upstream feature fixtures in `test/messenger.test.ts`; runners use injected HTTP/socket/timer interfaces.
* `scripts/src/boot.ts`, `config.ts`, `references/config.example.json`, `references/setup.md`, `references/onboarding.md`: inspected boot auth, token/setup and hook routing. Retained explicit setup and account checks, while excluding implicit environment-token lookup, automatic onboarding crawl and the prior agent runtime. Upstream Telegram/Discord inbound depended on external messenger setup; this fork supplies direct Bot API/Gateway consumers and Discord REST recovery.

Offline runner E2E uses real harness admission/allocation/pivot/ACK/READY/DONE and fake native sessions/provider transports. It is not real-account, native-server, delivery, installation or deployment proof. Native process/socket tests must pass on an allowed host or CI before merging. Exact review and merge gates are unchanged.

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

When using the Dori task system, supply `start KEY --brief FILE --origin origin.json` so the task and messenger journal capture the route before kickoff. Late binding cannot retarget an admitted task; standalone primitives do not infer a task origin.

Journal origins require an explicit account identity and include platform, account, workspace, channel, thread/topic and original source message when supplied. Rebinding to another origin is refused; there is no fallback to a different channel or to the Codex conversation. A known receipt deduplicates an exact retry across restart. Changed content or destination under the same delivery ID is rejected. A crash, timeout, disconnect, malformed success or server error stays uncertain, and the same delivery is never blindly replayed. `reconcile(id, delivered, messageId?)` records a human-verified platform outcome only after acquiring the same per-delivery lease as the sender. A live in-flight send cannot be reconciled; crashed sending intent remains recoverable through stale-owner lease recovery. A confirmed rejection does not silently create another send attempt either.

The upstream rate-limit backoff is retained for HTTP 429. Non-idempotent writes are not retried on a 5xx or a lost response. Transport exceptions and API error bodies are not persisted or echoed, so Telegram token-bearing URLs and arbitrary remote error prose do not leak into receipts. Credentials are not saved in journal state. Discord edits and sends disable automatic mentions.

## Inbound contract

An authenticated host supplies an `InboundEnvelope` containing `id`, `origin`, `authorId`, `text` and optional `quoted`/`forwarded` flags. `acceptInbound(event,{ownerId,verify,task?})` calls the host verifier, checks the configured owner and task route (platform, account, workspace, channel and thread), persists the event, and returns `{duplicate,task?,event}`. A new follow-up may have a different source message ID on that same route; the task's original reply binding remains immutable. Quoted, forwarded and other people's messages are content rather than requests. This verifier callback is a trust boundary, not a replacement for platform authentication.

Keep the event unhandled until the task system has durably admitted the request. Retry dispatch using that persisted unhandled event after a crash; do not skip it merely because `duplicate` is true. Then call `markInboundHandled(platform,account,eventId,workspace?)`. Slack poll cursors similarly advance through `ThreadLedger.markSeen` **after** durable admission, so a crash between discovery and admission cannot discard the owner's message. Namespace each thread ledger with `{account,workspace}` when multiple accounts share its file.

Pages remains the owner-facing dashboard. Messenger adapters return a result to the request's recorded origin only after explicit connection setup; they do not mirror every lane update to every platform.
