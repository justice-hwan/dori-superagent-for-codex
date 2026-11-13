import { readFile } from "node:fs/promises";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { BridgeError, Principal } from "./schema.ts";

export class Auth {
  readonly #resource: string;
  readonly #issuer: string;
  readonly #principalFile: string;
  readonly #keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: {
    readonly resource: string;
    readonly issuer: string;
    readonly jwksUrl: string;
    readonly principalFile: string;
  }) {
    const urls = [config.resource, config.issuer, config.jwksUrl].map((value) => {
      if (!z.url().safeParse(value).success) {
        throw new BridgeError(-32001, "Invalid OAuth URL");
      }
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) {
        throw new BridgeError(-32001, "OAuth URLs must use HTTPS without credentials or fragments");
      }
      return url;
    });
    const [, issuer, jwks] = urls;
    if (!issuer || !jwks || issuer.origin !== jwks.origin) {
      throw new BridgeError(-32001, "JWKS must share the issuer origin");
    }
    if (!config.principalFile.trim()) {
      throw new BridgeError(-32001, "Principal file is required");
    }
    this.#resource = config.resource;
    this.#issuer = config.issuer;
    this.#principalFile = config.principalFile;
    this.#keys = createRemoteJWKSet(jwks, {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
    });
  }

  metadata() {
    return {
      resource: this.#resource,
      authorization_servers: [this.#issuer],
      scopes_supported: ["dori:jobs"],
    };
  }

  async authenticate(request: Request): Promise<{
    readonly principal: Principal;
    readonly expires: number;
  }> {
    const bearer = /^Bearer +(\S+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!bearer?.[1]) {
      throw new BridgeError(-32001, "Bearer token is required");
    }
    try {
      const { payload } = await jwtVerify(bearer[1], this.#keys, {
        algorithms: ["ES256", "RS256"],
        issuer: this.#issuer,
        audience: this.#resource,
        requiredClaims: ["exp", "sub", "scope"],
      });
      const expires = payload.exp;
      if (typeof expires !== "number" || !Number.isFinite(expires) || expires > Math.floor(Date.now() / 1000) + 3600) {
        throw new BridgeError(-32001, "Token expiration exceeds one hour");
      }
      if (typeof payload["scope"] !== "string" || !payload["scope"].split(" ").includes("dori:jobs")) {
        throw new BridgeError(-32001, "Required scope is missing");
      }
      const principal = Principal.safeParse(payload.sub);
      if (!principal.success) {
        throw new BridgeError(-32001, "Invalid token subject");
      }
      if (!(await this.allowed(principal.data))) {
        throw new BridgeError(-32001, "Principal is not allowed");
      }
      return { principal: principal.data, expires };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(-32001, "Invalid access token");
    }
  }

  async allowed(principal: string): Promise<boolean> {
    try {
      const content: unknown = JSON.parse(await readFile(this.#principalFile, "utf8"));
      const principals = z.array(Principal).safeParse(content);
      return principals.success && principals.data.some((allowed) => allowed === principal);
    } catch {
      // no-excuse-ok: catch -- file authorization boundary fails closed.
      return false;
    }
  }
}
