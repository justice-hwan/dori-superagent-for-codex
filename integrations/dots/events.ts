import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BridgeError, type Principal, type Subscribe, type Unsubscribe } from "./schema.ts";
import { digest, type Store } from "./store.ts";
import { postWebhook, TransportError } from "./transport.ts";

/** Durable, non-replayable event subscriptions. Outbox retains admitted deliveries across restarts. */
export class Events {
  private draining = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    readonly store: Store,
    readonly allowed: (principal: string) => Promise<boolean>,
  ) {}

  async subscribe(principal: Principal, input: Subscribe, accessExpires: number) {
    this.store.job(principal, input.arguments.job_id);
    const id = `sub_${digest(JSON.stringify([principal, input.delivery.url, input.name, input.arguments.job_id]))}`;
    const challenge = randomBytes(32).toString("base64url");
    const cached = this.store.db
      .query("SELECT 1 FROM verifications WHERE principal=? AND url=? AND secret_hash=? AND until_at>?")
      .get(principal, input.delivery.url, digest(input.delivery.secret), Date.now());
    if (!cached) {
      let response: { readonly status: number; readonly body: string };
      try {
        response = await postWebhook(
          input.delivery.url,
          input.delivery.secret,
          id,
          `verify_${crypto.randomUUID()}`,
          JSON.stringify({ type: "verification", challenge }),
        );
      } catch (error) {
        if (error instanceof TransportError) throw new BridgeError(-32015, error.reason);
        throw error;
      }
      const echo = z
        .object({ challenge: z.string() })
        .safeParse(response.status >= 200 && response.status < 300 ? parseJson(response.body) : undefined);
      if (!echo.success || !equal(echo.data.challenge, challenge)) throw new BridgeError(-32015, "challenge_failed");
      this.store.db.run(
        `INSERT INTO verifications VALUES(?,?,?,?) ON CONFLICT(principal,url)
      DO UPDATE SET secret_hash=excluded.secret_hash,until_at=excluded.until_at`,
        [principal, input.delivery.url, digest(input.delivery.secret), Date.now() + 300000],
      );
    }
    const previous = this.store.subscription(id);
    const lifetime = input.ttlMs ?? 3600000;
    const expires = Math.min(Date.now() + lifetime, accessExpires);
    if (expires <= Date.now()) throw new BridgeError(-32001, "expired_access");
    const changed = previous && previous.secret !== input.delivery.secret;
    this.store.db.run(
      `INSERT INTO subscriptions(id,principal,name,job_id,url,secret,old_secret,rotate_until,expires)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      secret=excluded.secret, old_secret=excluded.old_secret, rotate_until=excluded.rotate_until, expires=excluded.expires`,
      [
        id,
        principal,
        input.name,
        input.arguments.job_id,
        input.delivery.url,
        input.delivery.secret,
        changed ? previous.secret : (previous?.old_secret ?? ""),
        changed ? Date.now() + 300000 : (previous?.rotate_until ?? 0),
        expires,
      ],
    );
    return {
      id,
      refreshBefore: new Date(expires).toISOString(),
      cursor: null,
      truncated: false,
    };
  }

  unsubscribe(principal: Principal, input: Unsubscribe): void {
    const id = `sub_${digest(JSON.stringify([principal, input.delivery.url, input.name, input.arguments.job_id]))}`;
    this.store.db.run("DELETE FROM subscriptions WHERE id=? AND principal=?", [id, principal]);
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      for (const item of this.store.pending(Date.now())) {
        const sub = this.store.subscription(item.subscription_id);
        if (!sub || sub.expires <= Date.now() || !(await this.allowed(sub.principal))) {
          this.store.db.run("DELETE FROM subscriptions WHERE id=?", [item.subscription_id]);
          continue;
        }
        let status: number;
        try {
          status = (
            await postWebhook(
              sub.url,
              sub.secret,
              sub.id,
              item.event_id,
              item.body,
              sub.rotate_until > Date.now() && sub.old_secret ? sub.old_secret : undefined,
            )
          ).status;
        } catch (error) {
          if (!(error instanceof TransportError)) throw error;
          status = 503;
        }
        const transient = status === 429 || status >= 500;
        if ((status >= 200 && status < 300) || !transient || item.attempts >= 4) {
          this.store.db.run("INSERT OR REPLACE INTO receipts VALUES(?,?,?,?,?)", [
            item.event_id,
            sub.id,
            status,
            item.attempts + 1,
            Date.now(),
          ]);
          this.store.db.run("DELETE FROM outbox WHERE event_id=? AND subscription_id=?", [item.event_id, sub.id]);
          if (status === 410) this.store.db.run("DELETE FROM subscriptions WHERE id=?", [sub.id]);
        } else {
          this.store.db.run("UPDATE outbox SET attempts=attempts+1,next_at=? WHERE event_id=? AND subscription_id=?", [
            Date.now() + 1000 * 2 ** item.attempts,
            item.event_id,
            sub.id,
          ]);
        }
      }
    } finally {
      this.draining = false;
      const row = z
        .object({ next: z.number().nullable() })
        .parse(this.store.db.query("SELECT MIN(next_at) AS next FROM outbox").get());
      if (row.next !== null)
        this.timer = setTimeout(
          () => {
            void this.drain().catch((error: unknown) => {
              console.error("Dots outbox failed", error instanceof Error ? error.name : "unknown");
            });
          },
          Math.max(1, row.next - Date.now()),
        );
    }
  }
  close(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
