import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { Auth } from "./auth.ts";
import { BridgeError, Principal } from "./schema.ts";

const resource = "https://bridge.example/mcp";
const issuer = "https://issuer.example/tenant";
const jwksUrl = "https://issuer.example/tenant/jwks";
const ec = await generateKeyPair("ES256");
const rsa = await generateKeyPair("RS256");
const keys = [
  { ...(await exportJWK(ec.publicKey)), kid: "ec", alg: "ES256" },
  { ...(await exportJWK(rsa.publicKey)), kid: "rsa", alg: "RS256" },
];
let directory: string;
let principalFile: string;
let auth: Auth;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dots-auth-"));
  principalFile = join(directory, "principals.json");
  await writeFile(principalFile, JSON.stringify(["alice"]));
  auth = new Auth({ resource, issuer, jwksUrl, principalFile });
  // Replace only the external JWKS transport; signing and verification remain real.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo) => {
        if (String(input) !== jwksUrl) throw new TypeError("Unexpected JWKS URL");
        return Response.json({ keys });
      },
      { preconnect: fetch.preconnect },
    ),
  );
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

function claims(overrides: Readonly<Record<string, unknown>> = {}): JWTPayload {
  return {
    iss: issuer,
    aud: resource,
    sub: "alice",
    exp: Math.floor(Date.now() / 1000) + 600,
    scope: "profile dori:jobs",
    ...overrides,
  };
}

async function request(payload: JWTPayload, algorithm = "ES256"): Promise<Request> {
  const key = algorithm === "RS256" ? rsa.privateKey : ec.privateKey;
  const token = await new SignJWT(payload)
    .setProtectedHeader({
      alg: algorithm,
      kid: algorithm === "RS256" ? "rsa" : "ec",
    })
    .sign(key);
  return new Request(resource, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function denied(pending: Promise<unknown>, reason?: string): Promise<void> {
  const error: unknown = await pending.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(BridgeError);
  if (error instanceof BridgeError) {
    expect(error.code).toBe(-32001);
    if (reason) expect(error.reason).toBe(reason);
  }
}

describe("OAuth resource authentication", () => {
  test("publishes the exact configured resource and external issuer", () => {
    expect(auth.metadata()).toEqual({
      resource,
      authorization_servers: [issuer],
      scopes_supported: ["dori:jobs"],
    });
  });

  test.each(["ES256", "RS256"])("accepts a valid %s token", async (algorithm) => {
    const expires = Math.floor(Date.now() / 1000) + 600;
    const payload = claims({ exp: expires });
    const result = await auth.authenticate(await request(payload, algorithm));
    expect(result).toEqual({ principal: Principal.parse("alice"), expires });
  });

  test.each([
    ["issuer", { iss: `${issuer}/` }],
    ["audience", { aud: "https://other.example" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 1 }],
    ["missing expiry", { exp: undefined }],
    ["long expiry", { exp: Math.floor(Date.now() / 1000) + 7200 }],
    ["missing scope", { scope: undefined }],
    ["scope substring", { scope: "dori:jobs:admin" }],
    ["scope array", { scope: ["dori:jobs"] }],
    ["empty subject", { sub: "" }],
    ["missing subject", { sub: undefined }],
    ["oversized subject", { sub: "a".repeat(129) }],
    ["unknown subject", { sub: "mallory" }],
    ["not yet valid", { nbf: Math.floor(Date.now() / 1000) + 600 }],
  ] satisfies [string, Readonly<Record<string, unknown>>][])("rejects %s", async (_name, overrides) => {
    await denied(auth.authenticate(await request(claims(overrides))));
  });

  test("rejects a signature from an untrusted key", async () => {
    const other = await generateKeyPair("ES256");
    const token = await new SignJWT(claims()).setProtectedHeader({ alg: "ES256", kid: "ec" }).sign(other.privateKey);
    await denied(
      auth.authenticate(
        new Request(resource, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
      "Invalid access token",
    );
  });

  test("rejects symmetric algorithms even for otherwise valid claims", async () => {
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: "HS256" })
      .sign(crypto.getRandomValues(new Uint8Array(32)));
    await denied(
      auth.authenticate(
        new Request(resource, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
      "Invalid access token",
    );
  });

  test.each(["", "Basic abc", "Bearer abc def", "Bearer broken.jwt.token"])(
    "rejects invalid authorization header %s",
    async (authorization) => {
      await denied(auth.authenticate(new Request(resource, { headers: { authorization } })));
    },
  );

  test("rejects unavailable JWKS without exposing transport errors", async () => {
    fetchSpy.mockImplementation(
      Object.assign(
        async () => {
          throw new TypeError("private transport detail");
        },
        { preconnect: fetch.preconnect },
      ),
    );
    await denied(auth.authenticate(await request(claims())), "Invalid access token");
  });

  test("rechecks authorization for an already verified token", async () => {
    const signed = await request(claims());
    await auth.authenticate(signed);
    await writeFile(principalFile, "[]");
    await denied(auth.authenticate(signed), "Principal is not allowed");
  });
});

describe("delivery authorization", () => {
  test("reloads the allowlist for every delivery", async () => {
    expect(await auth.allowed("alice")).toBe(true);
    await writeFile(principalFile, '["bob"]');
    expect(await auth.allowed("alice")).toBe(false);
    expect(await auth.allowed("bob")).toBe(true);
  });

  test.each(["{", "null", "{}", '["alice", 1]', '["alice", ""]'])(
    "fails closed on malformed allowlist %s",
    async (content) => {
      await writeFile(principalFile, content);
      expect(await auth.allowed("alice")).toBe(false);
    },
  );

  test("fails closed when the allowlist disappears", async () => {
    await rm(principalFile);
    expect(await auth.allowed("alice")).toBe(false);
  });
});

describe("trusted configuration", () => {
  test.each([
    { resource: "http://bridge.example" },
    { issuer: "http://issuer.example" },
    { jwksUrl: "http://issuer.example/jwks" },
    { resource: "not a URL" },
    { issuer: "https://user:secret@issuer.example" },
    { jwksUrl: "https://attacker.example/jwks" },
    { jwksUrl: "https://issuer.example:444/jwks" },
    { resource: `${resource}#fragment` },
    { principalFile: "" },
  ])("rejects invalid configuration %j", (overrides) => {
    expect(() => new Auth({ resource, issuer, jwksUrl, principalFile, ...overrides })).toThrow(BridgeError);
  });
});
