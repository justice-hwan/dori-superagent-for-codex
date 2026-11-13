import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

export class TransportError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TransportError";
  }
}
const privateNetworks = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  privateNetworks.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  privateNetworks.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !privateNetworks.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !privateNetworks.check(address, "ipv6");
}
function signingKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new TransportError("invalid_secret");
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new TransportError("invalid_secret");
  }
  return key;
}

/** Resolve every destination on each delivery and connect directly to a validated IP, retaining hostname TLS verification. */
export async function postWebhook(
  destination: string,
  secret: string,
  subscriptionId: string,
  eventId: string,
  body: string,
  previousSecret?: string,
): Promise<{ readonly status: number; readonly body: string }> {
  let url: URL;
  try {
    url = new URL(destination);
  } catch (error) {
    if (error instanceof TypeError) throw new TransportError("invalid_url");
    throw error;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) {
    throw new TransportError("invalid_url");
  }
  if (Buffer.byteLength(body) > 262144) throw new TransportError("payload_too_large");
  const keys = [signingKey(secret), ...(previousSecret ? [signingKey(previousSecret)] : [])];
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const started = Date.now();
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
  if (addresses.length === 0 || addresses.some((entry) => !publicAddress(entry.address))) {
    throw new TransportError("non_public_address");
  }
  const selected = addresses[0];
  if (!selected) throw new TransportError("dns_failed");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = keys
    .map((key) => `v1,${createHmac("sha256", key).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`)
    .join(" ");
  return new Promise((resolve, reject) => {
    const call = request(
      {
        hostname: selected.address,
        port: 443,
        method: "POST",
        path: `${url.pathname}${url.search}`,
        servername: isIP(hostname) ? "" : hostname,
        agent: false,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
        signal: AbortSignal.timeout(Math.max(1, 10000 - (Date.now() - started))),
        headers: {
          Host: url.host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "webhook-id": eventId,
          "webhook-timestamp": timestamp,
          "webhook-signature": signature,
          "X-MCP-Subscription-Id": subscriptionId,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 65536) {
            call.destroy(new TransportError("response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.once("error", () => reject(new TransportError("delivery_failed")));
      },
    );
    call.once("error", (error) =>
      reject(
        error instanceof TransportError
          ? error
          : new TransportError(error.name === "AbortError" ? "timeout" : "delivery_failed"),
      ),
    );
    call.end(body);
  });
}
async function resolve(hostname: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TransportError("timeout")), 5000);
      }),
    ]);
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError("dns_failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
