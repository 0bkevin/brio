import { createDPoPProof, getDPoPThumbprint } from "@/lib/dpop";
import { Platform } from "react-native";

const RELAY_TOKEN_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const RELAY_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const RELAY_ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const RELAY_CLIENT_ID = Platform.OS === "web" ? "brio-web" : "brio-mobile";

type RelayIdentityTokenProvider = () => Promise<string | null>;
let relayIdentityTokenProvider: RelayIdentityTokenProvider | null = null;

export function setRelayIdentityTokenProvider(
  provider: RelayIdentityTokenProvider | null,
) {
  relayIdentityTokenProvider = provider;
}

export function resetRelayDPoPTokens() {
  relayDPoPTokens.clear();
}

async function currentRelayIdentityToken() {
  const token = await relayIdentityTokenProvider?.();
  if (!token) throw new Error("Sign in to Brio Connect again");
  return token;
}

export type AgentConnection = {
  id: string;
  name: string;
  mode: "self_hosted" | "brio_hosted";
  transport: "relay" | "direct";
  status: "online" | "offline" | "connecting" | "error";
  capabilities: Record<string, unknown>;
  url: string;
  token: string;
  relayToken?: string;
  relayURL?: string;
  relayDeviceId?: string;
  agentId?: string;
  pairingCode?: string;
  authMode?: "bearer" | "dpop";
  cloudUserID?: string;
};

export type HealthResponse = {
  ok: boolean;
  hermes_ok?: boolean;
  hermes_status?: number;
  hermes_home?: string;
  service?: string;
  hermes?: unknown;
  allowed_roots?: string[];
};

export type CapabilitiesResponse = {
  companion?: Record<string, unknown>;
  hermes?: unknown;
};

export type RelayDeviceSession = {
  user: { id: string; email: string };
  device: { id: string; user_id: string; name: string };
  token: string;
};

export type RelayAgent = {
  id: string;
  name: string;
  mode: "self_hosted" | "brio_hosted";
  status: AgentConnection["status"];
  created_at?: string;
  last_seen_at?: string | null;
  endpoint?: RelayManagedEndpoint;
};

export type RelayManagedEndpoint = {
  http_base_url: string;
  ws_base_url: string;
  provider_kind: string;
};

export type RelayConnectResponse = {
  environment_id: string;
  endpoint: RelayManagedEndpoint;
  credential: string;
  expires_at: string;
};

type RelayDPoPTokenResponse = {
  access_token: string;
  issued_token_type: typeof RELAY_ACCESS_TOKEN_TYPE;
  token_type: "DPoP";
  expires_in: number;
  scope: string;
};

type RelayDPoPToken = {
  accessToken: string;
  expiresAt: number;
  scopes: string;
};

export type RelayClaimResponse = {
  agent: {
    id: string;
    name: string;
    mode: "self_hosted" | "brio_hosted";
    status: AgentConnection["status"];
  };
};

export type RelayRecoveryResponse = {
  code: string;
  agent_token: string;
  agent_id: string;
  name: string;
  expires_at: string;
  created_at: string;
};

export type RelayEnrollmentResponse = {
  code: string;
  name: string;
  expires_at: string;
  created_at: string;
};

function normalizeBaseURL(url: string) {
  return url.trim().replace(/\/+$/, "");
}

function cleanConnectionValue(value: string) {
  return value.trim().replace(/^["'`]+|[,"'`.;]+$/g, "");
}

export async function brioFetch<T>(
  connection: Pick<AgentConnection, "url" | "token"> & Partial<AgentConnection>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (connection.transport === "relay") {
    return relayFetch<T>(connection, path, init);
  }
  const target = `${normalizeBaseURL(connection.url)}${path}`;
  const cacheKey = connection.agentId ?? connection.id ?? connection.url;
  let accessToken = dpopAccessTokens.get(cacheKey) ?? connection.token;
  const request = async () =>
    fetch(target, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `${connection.authMode === "dpop" ? "DPoP" : "Bearer"} ${accessToken}`,
        ...(connection.authMode === "dpop"
          ? {
              DPoP: await createDPoPProof(
                init.method ?? "GET",
                target,
                accessToken,
              ),
            }
          : {}),
        ...(init.headers ?? {}),
      },
    });
  let response = await request();
  if (
    response.status === 401 &&
    connection.authMode === "dpop" &&
    connection.relayURL &&
    connection.agentId
  ) {
    const identityToken =
      connection.relayToken ?? (await currentRelayIdentityToken());
    const refreshed = await connectRelayEnvironment(
      connection.relayURL,
      identityToken,
      connection.agentId,
      connection.relayDeviceId,
    );
    const exchanged = await exchangeEnvironmentCredential(
      refreshed.response.endpoint.http_base_url,
      refreshed.response.credential,
      refreshed.thumbprint,
    );
    accessToken = exchanged.access_token;
    dpopAccessTokens.set(cacheKey, accessToken);
    response = await request();
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      body?.error ?? body?.message ?? `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

const dpopAccessTokens = new Map<string, string>();

export function getHealth(
  connection: Pick<AgentConnection, "url" | "token"> & Partial<AgentConnection>,
) {
  return brioFetch<HealthResponse>(connection, "/health");
}

export function getCapabilities(
  connection: Pick<AgentConnection, "url" | "token"> & Partial<AgentConnection>,
) {
  return brioFetch<CapabilitiesResponse>(connection, "/capabilities");
}

export async function sendResponse(
  connection: Pick<AgentConnection, "url" | "token"> & Partial<AgentConnection>,
  prompt: string,
) {
  return brioFetch<Record<string, unknown>>(connection, "/chat/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "hermes-agent",
      input: prompt,
      stream: false,
    }),
  });
}

export type PairingPayload = {
  url: string;
  token: string;
  mode?: "direct" | "relay";
  transport?: "direct" | "relay";
  agent_id?: string;
  code?: string;
};

export function decodePairingPayload(raw: string): PairingPayload {
  const value = raw.trim();
  if (!value) {
    throw new Error("Pairing payload is empty");
  }
  try {
    return JSON.parse(value) as PairingPayload;
  } catch {
    return JSON.parse(decodeBase64URL(value)) as PairingPayload;
  }
}

export function extractPairingPayload(raw: string): PairingPayload {
  const value = raw.trim();
  if (!value) {
    throw new Error("Hermes reply is empty");
  }

  const notReadyMatch = value.match(/^\s*NOT\s+READY\s*:\s*(.+)$/is);
  if (notReadyMatch) {
    throw new Error(notReadyMatch[1].trim());
  }

  try {
    return decodePairingPayload(value);
  } catch {
    // Fall through to more forgiving parsing for human-readable Hermes replies.
  }

  const jsonBlock = value.match(/\{[\s\S]*\}/)?.[0];
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock) as PairingPayload;
    } catch {
      // Ignore and continue with label-based parsing.
    }
  }

  const urlMatch =
    value.match(/(?:^|\n)\s*url\s*:\s*(\S+)/i) ??
    value.match(/\bhttps?:\/\/[^\s"'`]+/i);
  const tokenMatch = value.match(/(?:^|\n)\s*token\s*:\s*([^\s]+)/i);

  if (!urlMatch || !tokenMatch) {
    throw new Error(
      "Could not find a pairing payload or URL/token in the Hermes reply",
    );
  }

  return {
    url: cleanConnectionValue(urlMatch[1] ?? urlMatch[0]),
    token: cleanConnectionValue(tokenMatch[1]),
    mode: "direct",
    transport: "direct",
  };
}

export function connectionFromPairingPayload(
  payload: PairingPayload,
): AgentConnection {
  const transport = payload.transport ?? payload.mode ?? "direct";
  return {
    id: payload.agent_id ?? "self-hosted-local",
    name: "Hermes",
    mode: "self_hosted",
    transport,
    status: "connecting",
    capabilities: {},
    url: payload.url,
    token: payload.token,
    agentId: payload.agent_id,
    pairingCode: payload.code,
  };
}

export async function createRelayDevice(
  relayURL: string,
  email = "dev@brio.local",
  deviceName = "Brio mobile",
) {
  const response = await fetch(`${normalizeBaseURL(relayURL)}/auth/devices`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, device_name: deviceName }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? "Could not create relay device");
  }
  return body as RelayDeviceSession;
}

const relayDPoPTokens = new Map<string, RelayDPoPToken>();

function relayTokenSubject(token: string) {
  try {
    const payload = JSON.parse(decodeBase64URL(token.split(".")[1] ?? "")) as {
      sub?: string;
    };
    return payload.sub ?? "";
  } catch {
    return "";
  }
}

async function exchangeRelayDPoPToken(
  relayURL: string,
  identityToken: string,
  scopes: readonly string[],
) {
  const baseURL = normalizeBaseURL(relayURL);
  const target = `${baseURL}/v1/client/dpop-token`;
  const scope = [...scopes].sort().join(" ");
  const cacheKey = `${baseURL}|${relayTokenSubject(identityToken)}|${RELAY_CLIENT_ID}|${scope}`;
  const cached = relayDPoPTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5000) return cached;
  const form = new URLSearchParams({
    grant_type: RELAY_TOKEN_GRANT,
    subject_token: identityToken,
    subject_token_type: RELAY_SUBJECT_TOKEN_TYPE,
    requested_token_type: RELAY_ACCESS_TOKEN_TYPE,
    resource: baseURL,
    scope,
    client_id: RELAY_CLIENT_ID,
  });
  const response = await fetch(target, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      DPoP: await createDPoPProof("POST", target),
    },
    body: form.toString(),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body?.reason ?? body?.error ?? "Could not authorize this device",
    );
  const token = body as RelayDPoPTokenResponse;
  if (
    token.token_type !== "DPoP" ||
    token.scope.split(/\s+/).sort().join(" ") !== scope
  ) {
    throw new Error("Relay granted an unexpected device authorization");
  }
  const result = {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scopes: token.scope,
  };
  relayDPoPTokens.set(cacheKey, result);
  return result;
}

async function relayDPoPFetch(
  relayURL: string,
  identityToken: string,
  scopes: readonly string[],
  path: string,
  init: RequestInit = {},
) {
  const target = `${normalizeBaseURL(relayURL)}${path}`;
  const request = async (forceRefresh: boolean) => {
    if (forceRefresh) resetRelayDPoPTokens();
    const authorization = await exchangeRelayDPoPToken(
      relayURL,
      identityToken,
      scopes,
    );
    return fetch(target, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `DPoP ${authorization.accessToken}`,
        DPoP: await createDPoPProof(
          init.method ?? "GET",
          target,
          authorization.accessToken,
        ),
        ...(init.headers ?? {}),
      },
    });
  };
  let response = await request(false);
  if (response.status === 401) response = await request(true);
  return response;
}

export async function claimRelayPairing(
  relayURL: string,
  relayToken: string,
  pairingCode: string,
) {
  const response = await fetch(
    `${normalizeBaseURL(relayURL)}/pairings/${encodeURIComponent(pairingCode)}/claim`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${relayToken}`,
      },
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? "Could not claim pairing");
  }
  return body as RelayClaimResponse;
}

export async function listRelayAgents(relayURL: string, relayToken: string) {
  const response = await fetch(
    `${normalizeBaseURL(relayURL)}/v1/environments`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${relayToken}`,
      },
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? "Could not load agents");
  }
  return (body?.environments ?? []) as RelayAgent[];
}

export async function getRelayEnvironmentStatus(
  relayURL: string,
  identityToken: string,
  environmentID: string,
) {
  const response = await relayDPoPFetch(
    relayURL,
    identityToken,
    ["environment:status"],
    `/v1/environments/${encodeURIComponent(environmentID)}/status`,
    { method: "POST" },
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body?.reason ?? body?.error ?? "Could not check environment status",
    );
  return body as { status: "online" | "offline"; error?: string };
}

export async function unlinkRelayEnvironment(
  relayURL: string,
  relayToken: string,
  environmentID: string,
) {
  const response = await fetch(
    `${normalizeBaseURL(relayURL)}/v1/client/environment-links/${encodeURIComponent(environmentID)}`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${relayToken}`,
      },
    },
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body?.reason ?? body?.error ?? "Could not unlink environment",
    );
  return body as { ok: boolean };
}

export async function createRelayEnrollment(
  relayURL: string,
  relayToken: string,
  name = "Hermes",
) {
  const response = await fetch(`${normalizeBaseURL(relayURL)}/enrollments`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${relayToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? "Could not create enrollment");
  }
  return body as RelayEnrollmentResponse;
}

export async function recoverRelayAgent(
  relayURL: string,
  relayToken: string,
  agentID: string,
  name?: string,
) {
  const response = await fetch(
    `${normalizeBaseURL(relayURL)}/agents/${encodeURIComponent(agentID)}/recover`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${relayToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(name ? { name } : {}),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? "Could not recover relay agent");
  }
  return body as RelayRecoveryResponse;
}

export async function connectRelayEnvironment(
  relayURL: string,
  identityToken: string,
  environmentID: string,
  deviceID?: string,
) {
  const thumbprint = await getDPoPThumbprint();
  const response = await relayDPoPFetch(
    relayURL,
    identityToken,
    ["environment:connect"],
    `/v1/environments/${encodeURIComponent(environmentID)}/connect`,
    {
      method: "POST",
      body: JSON.stringify({
        client_proof_key_thumbprint: thumbprint,
        device_id: deviceID,
      }),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      body?.reason ?? body?.error ?? "Could not connect environment",
    );
  }
  return { response: body as RelayConnectResponse, thumbprint };
}

export async function registerRelayDevice(
  relayURL: string,
  identityToken: string,
  installationID: string,
  label: string,
) {
  const response = await relayDPoPFetch(
    relayURL,
    identityToken,
    ["mobile:registration"],
    "/v1/mobile/devices",
    {
      method: "POST",
      body: JSON.stringify({ device_id: installationID, label }),
    },
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body?.reason ?? body?.error ?? "Could not register this device",
    );
  return body as {
    device: { id: string; installation_id?: string; name: string };
  };
}

export async function unregisterRelayDevice(
  relayURL: string,
  identityToken: string,
  deviceID: string,
) {
  const response = await relayDPoPFetch(
    relayURL,
    identityToken,
    ["mobile:registration"],
    `/v1/mobile/devices/${encodeURIComponent(deviceID)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = await response.json();
    throw new Error(
      body?.reason ?? body?.error ?? "Could not unregister this device",
    );
  }
}

export async function exchangeEnvironmentCredential(
  endpointURL: string,
  credential: string,
  thumbprint: string,
) {
  const tokenURL = `${normalizeBaseURL(endpointURL)}/oauth/token`;
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type:
      "urn:brio:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_proof_key_thumbprint: thumbprint,
    scope: "brio:read brio:operate",
  });
  const response = await fetch(tokenURL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      DPoP: await createDPoPProof("POST", tokenURL),
    },
    body: form.toString(),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body?.error ?? "Could not exchange environment credential");
  return body as {
    access_token: string;
    token_type: "DPoP";
    expires_in: number;
  };
}

type RelayFrame = {
  type: "request" | "response" | "error";
  id: string;
  method?: string;
  path?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  code?: string;
  message?: string;
};

function relayFetch<T>(
  connection: Pick<AgentConnection, "url" | "token"> & Partial<AgentConnection>,
  path: string,
  init: RequestInit,
): Promise<T> {
  const agentId = connection.agentId ?? connection.id;
  if (!agentId) {
    return Promise.reject(new Error("Relay connection is missing an agent id"));
  }
  const frameId = `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const relayToken = connection.relayToken;
  if (!relayToken) {
    return Promise.reject(
      new Error("Relay connection is missing a device token"),
    );
  }
  const wsURL = relayTunnelURL(connection.url, agentId, relayToken);
  const body =
    typeof init.body === "string" && init.body.length > 0
      ? JSON.parse(init.body)
      : null;
  const requestFrame: RelayFrame = {
    type: "request",
    id: frameId,
    method: init.method ?? "GET",
    path,
    headers: {
      Authorization: `Bearer ${connection.token}`,
    },
    body,
  };

  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(wsURL);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Relay request timed out"));
    }, 30000);

    socket.onopen = () => {
      socket.send(JSON.stringify(requestFrame));
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Relay connection failed"));
    };
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as RelayFrame;
      if (frame.id !== frameId) {
        return;
      }
      clearTimeout(timeout);
      socket.close();
      if (frame.type === "error") {
        reject(
          new Error(frame.message ?? frame.code ?? "Relay request failed"),
        );
        return;
      }
      if ((frame.status ?? 500) >= 400) {
        const message =
          typeof frame.body === "object" && frame.body && "error" in frame.body
            ? String((frame.body as { error?: unknown }).error)
            : `Request failed: ${frame.status}`;
        reject(new Error(message));
        return;
      }
      resolve(frame.body as T);
    };
  });
}

function relayTunnelURL(baseURL: string, agentId: string, relayToken: string) {
  const normalized = normalizeBaseURL(baseURL);
  const withScheme =
    normalized.startsWith("http") || normalized.startsWith("ws")
      ? normalized
      : `https://${normalized}`;
  const url = new URL(withScheme);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/tunnel/mobile/${agentId}`;
  url.searchParams.set("token", relayToken);
  return url.toString();
}

function decodeBase64URL(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  if (typeof globalThis.atob === "function") {
    return globalThis.atob(padded);
  }

  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  let buffer = 0;
  let bits = 0;

  for (const char of padded) {
    if (char === "=") {
      break;
    }
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error("Pairing payload is not valid base64");
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }

  return output;
}
