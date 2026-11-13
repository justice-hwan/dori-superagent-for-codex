import { expect, test } from "bun:test";
import { postWebhook } from "./transport.ts";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
test.each([
  "https://127.0.0.1/",
  "https://10.1.2.3/",
  "https://100.100.100.200/",
  "https://169.254.169.254/",
  "https://172.16.0.1/",
  "https://192.168.1.2/",
  "https://0.0.0.0/",
  "https://224.0.0.1/",
  "https://198.18.0.1/",
  "https://192.0.2.1/",
  "https://203.0.113.1/",
  "https://[::1]/",
  "https://[::ffff:127.0.0.1]/",
  "https://[fc00::1]/",
  "https://[fe80::1]/",
  "https://[2001:db8::1]/",
  "https://[2002:7f00:1::]/",
  "https://[3fff::1]/",
])("refuses non-public callback destination %s before connecting", async (url) => {
  await expect(postWebhook(url, secret, "sub", "evt", "{}")).rejects.toThrow("non_public_address");
});
test.each([
  "http://example.com/",
  "https://user:password@example.com/",
  "https://example.com/#fragment",
  "https://example.com:8443/",
])("rejects unsafe callback URL %s", async (url) => {
  await expect(postWebhook(url, secret, "sub", "evt", "{}")).rejects.toThrow("invalid_url");
});
test.each(["invalid", "whsec_AAAA", `whsec_${Buffer.alloc(65).toString("base64")}`])(
  "rejects invalid signing key %s",
  async (key) => {
    await expect(postWebhook("https://127.0.0.1/", key, "sub", "evt", "{}")).rejects.toThrow("invalid_secret");
  },
);
test("rejects an oversized event before making a connection", async () => {
  await expect(postWebhook("https://127.0.0.1/", secret, "sub", "evt", "x".repeat(262145))).rejects.toThrow(
    "payload_too_large",
  );
});
