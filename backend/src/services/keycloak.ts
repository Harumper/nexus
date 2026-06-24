import * as openidClient from "openid-client";
import * as jose from "jose";

// ===================== Configuration =====================

export interface KeycloakConfig {
  url: string; // https://auth.example.com
  realm: string; // master
  clientId: string; // nexus
  clientSecret?: string; // optionnel pour les clients publics
  roleAdmin: string;
  roleOperator: string;
  roleReadonly: string;
}

let config: KeycloakConfig | null = null;
let oidcConfig: openidClient.Configuration | null = null;
// JWKS distant du realm : utilisé pour vérifier la SIGNATURE des tokens.
// Mis en cache par jose (rotation de clés gérée automatiquement via le kid).
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
let expectedIssuer: string | null = null;

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

  try {
    oidcConfig = await openidClient.discovery(
      new URL(issuerUrl),
      config.clientId,
      config.clientSecret
        ? { client_secret: config.clientSecret }
        : undefined,
    );

    // jwks_uri issu de la discovery (fallback sur le chemin standard Keycloak)
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
}

export async function verifyKeycloakToken(
  accessToken: string
): Promise<{ valid: boolean; payload?: KeycloakTokenPayload; error?: string }> {
  if (!jwks || !expectedIssuer) {
    return { valid: false, error: "Keycloak not initialized" };
  }

  try {
    // Contrôle AUTORITAIRE : vérification cryptographique de la signature via
    // le JWKS du realm + validation de l'issuer et de l'expiration (gérées par
    // jose). On n'accepte JAMAIS un token dont la signature n'est pas vérifiée,
    // et les rôles sont lus UNIQUEMENT depuis ce payload vérifié.
    const { payload } = await jose.jwtVerify(accessToken, jwks, {
      issuer: expectedIssuer,
      // Keycloak signe les access tokens en RS256/ES256 ; on interdit
      // explicitement les algorithmes symétriques et "none".
      algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256"],
    });

    const p = payload as unknown as {
      sub: string;
      preferred_username?: string;
      email?: string;
      name?: string;
      realm_access?: { roles: string[] };
      resource_access?: Record<string, { roles: string[] }>;
    };

    if (!p.sub) {
      return { valid: false, error: "Token missing sub claim" };
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

// ===================== OIDC Endpoints (pour le frontend) =====================

export function getOidcEndpoints() {
  if (!config) return null;

  return {
    url: config.url,
    realm: config.realm,
    clientId: config.clientId,
  };
}

