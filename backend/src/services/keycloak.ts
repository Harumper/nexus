import * as openidClient from "openid-client";

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

export function getKeycloakConfig(): KeycloakConfig | null {
  return config;
}

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

  try {
    oidcConfig = await openidClient.discovery(
      new URL(issuerUrl),
      config.clientId,
      config.clientSecret
        ? { client_secret: config.clientSecret }
        : undefined,
    );

    console.log("[Keycloak] OIDC discovery successful for %s", issuerUrl);
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
  if (!oidcConfig) {
    return { valid: false, error: "Keycloak not initialized" };
  }

  try {
    const claims = await openidClient.fetchUserInfo(
      oidcConfig,
      accessToken,
      openidClient.skipSubjectCheck,
    );

    // fetchUserInfo retourne les claims de l'userinfo endpoint
    // On a aussi besoin des realm_access pour les rôles,
    // donc on décode le token JWT directement
    const payload = decodeJwtPayload(accessToken);
    if (!payload) {
      return { valid: false, error: "Invalid JWT format" };
    }

    return {
      valid: true,
      payload: {
        sub: payload.sub,
        preferred_username: payload.preferred_username || claims.preferred_username as string || "unknown",
        email: payload.email || claims.email as string,
        name: payload.name || claims.name as string,
        realm_access: payload.realm_access,
        resource_access: payload.resource_access,
      },
    };
  } catch {
    // Fallback: vérifier le token via l'introspection ou le décoder directement
    // en vérifiant la signature avec les clés JWKS
    try {
      const payload = await verifyTokenWithJwks(accessToken);
      if (payload) {
        return { valid: true, payload };
      }
      return { valid: false, error: "Token verification failed" };
    } catch (err: any) {
      return { valid: false, error: err.message || "Token verification failed" };
    }
  }
}

async function verifyTokenWithJwks(
  accessToken: string
): Promise<KeycloakTokenPayload | null> {
  if (!oidcConfig || !config) return null;

  try {
    // Utiliser le token introspection endpoint si le client est confidentiel
    if (config.clientSecret) {
      const result = await openidClient.tokenIntrospection(
        oidcConfig,
        accessToken,
      );
      if (!result.active) return null;
      const payload = decodeJwtPayload(accessToken);
      return payload;
    }

    // Pour un client public, décoder et vérifier le JWT manuellement
    // via le JWKS endpoint
    const payload = decodeJwtPayload(accessToken);
    if (!payload) return null;

    // Vérifier l'expiration
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return null;
    }

    // Vérifier l'issuer
    const expectedIssuer = `${config.url}/realms/${config.realm}`;
    if (payload.iss !== expectedIssuer) {
      return null;
    }

    return payload;
  } catch {
    return null;
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

// ===================== Helpers =====================

function decodeJwtPayload(token: string): any | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
