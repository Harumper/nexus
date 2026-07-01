import * as openidClient from "openid-client";
import * as jose from "jose";

// ===================== Configuration =====================

export interface KeycloakConfig {
  url: string; // https://auth.example.com
  realm: string; // master
  clientId: string; // nexus
  clientSecret?: string; // optional for public clients
  roleAdmin: string;
  roleOperator: string;
  roleReadonly: string;
}

let config: KeycloakConfig | null = null;
let oidcConfig: openidClient.Configuration | null = null;
// Remote JWKS of the realm: used to verify the SIGNATURE of tokens.
// Cached by jose (key rotation handled automatically via the kid).
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
let expectedIssuer: string | null = null;
// Expected OIDC client: used to verify the token was indeed issued FOR Nexus
// (azp/aud), not for another client of the same Keycloak realm.
let expectedClientId: string | null = null;

export function isKeycloakEnabled(): boolean {
  const authMode = process.env.AUTH_MODE || "local";
  return authMode === "keycloak" || authMode === "both";
}

export function isLocalAuthEnabled(): boolean {
  const authMode = process.env.AUTH_MODE || "local";
  return authMode === "local" || authMode === "both";
}

// ===================== Initialisation =====================

export async function initKeycloak(): Promise<void> {
  if (!isKeycloakEnabled()) {
    console.log("[Keycloak] Disabled (AUTH_MODE=%s)", process.env.AUTH_MODE || "local");
    return;
  }

  const url = process.env.KEYCLOAK_URL;
  const realm = process.env.KEYCLOAK_REALM;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;

  if (!url || !realm || !clientId) {
    throw new Error(
      "KEYCLOAK_URL, KEYCLOAK_REALM, and KEYCLOAK_CLIENT_ID are required when AUTH_MODE includes keycloak"
    );
  }

  config = {
    url,
    realm,
    clientId,
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
    roleAdmin: process.env.KEYCLOAK_ROLE_ADMIN || "nexus-admin",
    roleOperator: process.env.KEYCLOAK_ROLE_OPERATOR || "nexus-operator",
    roleReadonly: process.env.KEYCLOAK_ROLE_READONLY || "nexus-readonly",
  };

  const issuerUrl = `${url}/realms/${realm}`;
  expectedIssuer = issuerUrl;
  expectedClientId = clientId;

  try {
    oidcConfig = await openidClient.discovery(
      new URL(issuerUrl),
      config.clientId,
      config.clientSecret
        ? { client_secret: config.clientSecret }
        : undefined,
    );

    // jwks_uri from discovery (fallback to the standard Keycloak path)
    const jwksUri =
      oidcConfig.serverMetadata().jwks_uri ||
      `${issuerUrl}/protocol/openid-connect/certs`;
    jwks = jose.createRemoteJWKSet(new URL(jwksUri));

    console.log("[Keycloak] OIDC discovery successful for %s (jwks: %s)", issuerUrl, jwksUri);
  } catch (err) {
    throw new Error(`[Keycloak] OIDC discovery failed for ${issuerUrl}: ${err}`);
  }
}

// ===================== Token Verification =====================

export interface KeycloakTokenPayload {
  sub: string;
  preferred_username: string;
  email?: string;
  name?: string;
  realm_access?: {
    roles: string[];
  };
  resource_access?: Record<string, { roles: string[] }>;
  // CONTROL-PLANE-002 — propagated so the dashboard WS can sweep expired sockets.
  exp?: number;
}

export async function verifyKeycloakToken(
  accessToken: string
): Promise<{ valid: boolean; payload?: KeycloakTokenPayload; error?: string }> {
  if (!jwks || !expectedIssuer) {
    return { valid: false, error: "Keycloak not initialized" };
  }

  try {
    // AUTHORITATIVE check: cryptographic signature verification via the realm's
    // JWKS + issuer and expiration validation (handled by jose). We NEVER accept
    // a token whose signature is not verified, and roles are read ONLY from this
    // verified payload.
    const { payload } = await jose.jwtVerify(accessToken, jwks, {
      issuer: expectedIssuer,
      // Keycloak signs access tokens with RS256/ES256; we explicitly forbid
      // symmetric algorithms and "none".
      algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256"],
    });

    const p = payload as unknown as {
      sub: string;
      azp?: string;
      exp?: number;
      preferred_username?: string;
      email?: string;
      name?: string;
      realm_access?: { roles: string[] };
      resource_access?: Record<string, { roles: string[] }>;
    };

    if (!p.sub) {
      return { valid: false, error: "Token missing sub claim" };
    }

    // Audience check: the token must have been issued FOR the Nexus client, not
    // for another client of the same realm (otherwise a token carrying a realm
    // role `nexus-admin` issued by another app would grant ADMIN here). Keycloak
    // sets `azp` = issuing client; we also accept an `aud` containing our client.
    // Tolerant if expectedClientId is not configured (breaks nothing).
    if (expectedClientId) {
      const aud = payload.aud;
      const audOk = Array.isArray(aud)
        ? aud.includes(expectedClientId)
        : aud === expectedClientId;
      if (p.azp !== expectedClientId && !audOk) {
        return { valid: false, error: "Token audience mismatch (issued for another client)" };
      }
    }

    return {
      valid: true,
      payload: {
        sub: p.sub,
        preferred_username: p.preferred_username || "unknown",
        email: p.email,
        name: p.name,
        realm_access: p.realm_access,
        resource_access: p.resource_access,
        exp: p.exp,
      },
    };
  } catch (err: any) {
    return { valid: false, error: err?.message || "Token verification failed" };
  }
}

// ===================== Role Mapping =====================

export function mapKeycloakRole(
  tokenPayload: KeycloakTokenPayload
): "ADMIN" | "OPERATOR" | "READONLY" {
  if (!config) return "READONLY";

  const realmRoles = tokenPayload.realm_access?.roles || [];

  if (realmRoles.includes(config.roleAdmin)) return "ADMIN";
  if (realmRoles.includes(config.roleOperator)) return "OPERATOR";
  if (realmRoles.includes(config.roleReadonly)) return "READONLY";

  // Default
  return "READONLY";
}

// ===================== OIDC Endpoints (for the frontend) =====================

export function getOidcEndpoints() {
  if (!config) return null;

  return {
    url: config.url,
    realm: config.realm,
    clientId: config.clientId,
  };
}

