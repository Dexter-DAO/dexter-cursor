/**
 * Connected-mode wallet read — `opendexter wallet` when a `connect` session exists.
 *
 * The load-bearing rule: this file NEVER derives the vault's on-chain address
 * or reads chain balances itself. The vault has a Swig two-address split — the
 * token's `dexter.vault` claim is the Swig STATE address, but user funds live
 * at a DERIVED wallet-PDA. Re-deriving locally would strand deposits at the
 * wrong address. Instead we call the HOSTED MCP server's `x402_wallet` tool
 * (which already computes the correct wallet-PDA deposit address + balances +
 * activation state) with the stored ES256 bearer, and display exactly what it
 * returns. Zero client-side address derivation.
 *
 * Auth lifecycle: the bearer is short-lived. On a 401 we refresh once against
 * dexter-api's connector token endpoint using the stored dlt_ refresh token,
 * persist the rotated pair, and retry the hosted call a single time. If the
 * refresh is refused, we tell the user to reconnect — we never fall back to
 * local derivation.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getApiBase, VERSION } from "../config.js";
import { loadSession, saveSession, type VaultSession } from "./store.js";

/** The connector rail's OAuth token endpoint (device grant + refresh). */
const TOKEN_PATH = "/api/connector/oauth/token";
/** Bearer-authenticated read-only authority evidence; never accepts identity input. */
export const GOVERNED_AUTHORITY_STATUS_PATH =
  "/api/connector/oauth/authority";
/** The client_id the connector rail knows this CLI by (matches connect.ts). */
const CLIENT_ID = "opendexter-cli";
/**
 * The hosted MCP server. The bearer's `aud` claim is minted for this exact
 * origin, so we always target it (a dev dexter-api still issues prod-aud vault
 * tokens). `OPENDEXTER_MCP_URL` overrides for local server testing.
 */
export const HOSTED_MCP_URL = process.env.OPENDEXTER_MCP_URL || "https://open.dexter.cash/mcp";

export type HostedRuntimeToolName =
  | "x402_search"
  | "x402_check"
  | "x402_fetch"
  | "x402_status"
  | "x402_access"
  | "x402_wallet"
  | "dexter_portfolio";

/**
 * The subset of the hosted `x402_wallet` structuredContent we read. Kept loose
 * (index signature) because the hosted server owns the full shape — we map
 * defensively and never assume fields beyond address + balance are present.
 */
export interface HostedWalletResult {
  /** The wallet-PDA deposit address (NOT the dexter.vault state address). */
  address?: string | null;
  solanaAddress?: string | null;
  evmAddress?: string | null;
  network?: string;
  chainBalances?: Record<
    string,
    { available: string | null; name?: string; tier?: string; unavailable?: boolean }
  >;
  balances?: {
    usdc?: number;
    fundedAtomic?: string;
    spentAtomic?: string;
    availableAtomic?: string;
    degraded?: boolean;
    unavailableChains?: string[];
  };
  supportedNetworks?: string[];
  /** Some hosted builds surface vault activation state; render it if present. */
  activated?: boolean;
  activation?: { activated?: boolean; state?: string } | string | boolean;
  /** Enrollment signals: present when the vault itself isn't set up yet. */
  vault_status?: string;
  mode?: string;
  enroll_url?: string;
  pairing_url?: string;
  /** Exact status evidence may be embedded by the hosted wallet runtime. */
  authority?: unknown;
  governedAuthority?: unknown;
  runtimeAuthority?: unknown;
  [key: string]: unknown;
}

export interface RuntimeAuthorityStatus {
  namespace: "opendexter-runtime-authority/v1";
  runtimeSource: "hosted_governed_x402";
  status: "active" | "inactive" | "unavailable" | "disconnected";
  active: boolean | null;
  authoritySource: string | null;
  grantId: string | null;
  grantRevision: number | null;
  logicalGrantActive: boolean | null;
  principal: Record<string, unknown> | null;
  limits: {
    maximumPerCallAmountAtomic: string | null;
    maximumDailyAmountAtomic: string | null;
    maximumAggregateAmountAtomic: string | null;
  } | null;
  remaining: {
    perCallAmountAtomic: string | null;
    dailyAmountAtomic: string | null;
    aggregateAmountAtomic: string | null;
  } | null;
  expiresAt: string | null;
  scopes: Record<string, unknown> | readonly string[] | null;
  activeRole: Record<string, unknown> | null;
  revocation: {
    revoked: boolean | null;
    manageUrl: string | null;
  };
  fallback: {
    available: false;
    enabled: false;
    active: false;
    automatic: false;
  };
  evidenceNamespace: string | null;
  reason: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Project only the exact governed-authority evidence contract. A wallet
 * balance, connect token, or arbitrary `authority` object is never promoted to
 * bounded payment authority. Missing evidence stays visibly unavailable.
 */
export function projectRuntimeAuthorityStatus(
  wallet: HostedWalletResult | Record<string, unknown> | null,
): RuntimeAuthorityStatus {
  const container = wallet ?? {};
  const candidates = [
    container.runtimeAuthority,
    container.governedAuthority,
    container.authority,
  ];
  const evidence = candidates
    .map(objectValue)
    .find((candidate) =>
      candidate?.namespace === "dexter-governed-agent-surface-authority/v1"
    ) ?? null;
  const fallback = {
    available: false as const,
    enabled: false as const,
    active: false as const,
    automatic: false as const,
  };

  if (!evidence) {
    return {
      namespace: "opendexter-runtime-authority/v1",
      runtimeSource: "hosted_governed_x402",
      status: "unavailable",
      active: null,
      authoritySource: null,
      grantId: null,
      grantRevision: null,
      logicalGrantActive: null,
      principal: null,
      limits: null,
      remaining: null,
      expiresAt: null,
      scopes: null,
      activeRole: null,
      revocation: {
        revoked: null,
        manageUrl: "https://dexter.cash/wallet",
      },
      fallback,
      evidenceNamespace: null,
      reason: "governed_authority_status_unavailable",
    };
  }

  const capacity = objectValue(evidence.capacity);
  const active = typeof evidence.active === "boolean" ? evidence.active : null;
  const mode = stringValue(evidence.mode);
  const principal = objectValue(evidence.principal);
  const scopesObject = objectValue(evidence.scopes);
  const activeRole = objectValue(evidence.activeRole);
  const scopesArray = Array.isArray(evidence.scopes)
    && evidence.scopes.every((scope) => typeof scope === "string")
    ? evidence.scopes as string[]
    : null;
  const grantId = stringValue(evidence.grantId);
  const grantRevision =
    typeof evidence.grantRevision === "number"
    && Number.isSafeInteger(evidence.grantRevision)
      ? evidence.grantRevision
      : null;
  const authoritySource = stringValue(evidence.source);
  const expiresAt = stringValue(evidence.expiresAt);
  const atomic = (value: unknown): value is string =>
    typeof value === "string" && /^\d+$/.test(value);
  const digest = (value: unknown): boolean =>
    typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
  const integer = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const exactPrincipal =
    principal !== null
    && stringValue(principal.actor) !== null
    && stringValue(principal.vaultPda) !== null
    && stringValue(principal.walletAddress) !== null
    && stringValue(principal.agentId) !== null;
  const exactCapacity =
    capacity !== null
    && atomic(capacity.maximumPerCallAmountAtomic)
    && atomic(capacity.remainingPerCallAmountAtomic)
    && BigInt(capacity.remainingPerCallAmountAtomic)
      <= BigInt(capacity.maximumPerCallAmountAtomic)
    && atomic(capacity.maximumDailyAmountAtomic)
    && atomic(capacity.usedDailyAmountAtomic)
    && atomic(capacity.remainingDailyAmountAtomic)
    && BigInt(capacity.usedDailyAmountAtomic)
      + BigInt(capacity.remainingDailyAmountAtomic)
      === BigInt(capacity.maximumDailyAmountAtomic)
    && atomic(capacity.maximumAggregateAmountAtomic)
    && atomic(capacity.usedAggregateAmountAtomic)
    && atomic(capacity.remainingAggregateAmountAtomic)
    && BigInt(capacity.usedAggregateAmountAtomic)
      + BigInt(capacity.remainingAggregateAmountAtomic)
      === BigInt(capacity.maximumAggregateAmountAtomic)
    && stringValue(capacity.evaluatedAt) !== null
    && Number.isFinite(Date.parse(String(capacity.evaluatedAt)))
    && digest(capacity.snapshotDigest);
  const exactActiveRole =
    activeRole?.status === "active"
    && integer(activeRole.roleId)
    && stringValue(activeRole.authoritySigner) !== null
    && integer(activeRole.sessionExpirySlot)
    && integer(activeRole.currentSlot)
    && activeRole.sessionExpirySlot >= activeRole.currentSlot
    && digest(activeRole.resolutionDigest);
  const completeActiveEvidence =
    active === true
    && mode === "bounded_payment_authority"
    && evidence.inactiveReason === null
    && evidence.logicalGrantActive === true
    && authoritySource === "mcp-link-token"
    && grantId !== null
    && grantRevision !== null
    && grantRevision >= 0
    && exactPrincipal
    && exactCapacity
    && expiresAt !== null
    && Number.isFinite(Date.parse(expiresAt))
    && scopesObject?.network === "solana-mainnet"
    && scopesObject.assetId === "usdc"
    && scopesObject.action === "send"
    && scopesObject.protocolId === "x402-exact-v2"
    && scopesObject.counterpartyScope === "any-valid-x402-seller"
    && evidence.revoked === false
    && exactActiveRole
    && evidence.fallback === false;

  return {
    namespace: "opendexter-runtime-authority/v1",
    runtimeSource: "hosted_governed_x402",
    status:
      completeActiveEvidence
        ? "active"
        : mode === "unavailable" || active === null || active === true
          ? "unavailable"
          : "inactive",
    active: completeActiveEvidence ? true : active === false ? false : null,
    authoritySource,
    grantId,
    grantRevision,
    logicalGrantActive:
      typeof evidence.logicalGrantActive === "boolean"
        ? evidence.logicalGrantActive
        : null,
    principal,
    limits: capacity
      ? {
          maximumPerCallAmountAtomic: stringValue(capacity.maximumPerCallAmountAtomic),
          maximumDailyAmountAtomic: stringValue(capacity.maximumDailyAmountAtomic),
          maximumAggregateAmountAtomic: stringValue(capacity.maximumAggregateAmountAtomic),
        }
      : null,
    remaining: capacity
      ? {
          perCallAmountAtomic: stringValue(capacity.remainingPerCallAmountAtomic),
          dailyAmountAtomic: stringValue(capacity.remainingDailyAmountAtomic),
          aggregateAmountAtomic: stringValue(capacity.remainingAggregateAmountAtomic),
        }
      : null,
    expiresAt,
    scopes: scopesObject ?? scopesArray,
    activeRole,
    revocation: {
      revoked: typeof evidence.revoked === "boolean" ? evidence.revoked : null,
      manageUrl: "https://dexter.cash/wallet",
    },
    fallback,
    evidenceNamespace: "dexter-governed-agent-surface-authority/v1",
    reason:
      active === true && !completeActiveEvidence
        ? "governed_authority_evidence_incomplete"
        : stringValue(evidence.inactiveReason),
  };
}

/**
 * Open one short-lived client to the canonical hosted MCP and return its exact
 * tool result. With no bearer this is the hosted anonymous surface; a stored
 * connect token selects the authenticated governed surface. This proxy never
 * transports wallet keys or model-authored authority fields.
 */
export async function callHostedTool(opts: {
  accessToken?: string | null;
  toolName: HostedRuntimeToolName;
  arguments?: Record<string, unknown>;
  serverUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<CallToolResult> {
  const url = new URL(opts.serverUrl ?? HOSTED_MCP_URL);
  const headers = opts.accessToken
    ? { Authorization: `Bearer ${opts.accessToken}` }
    : undefined;
  const transport = new StreamableHTTPClientTransport(url, {
    ...(headers ? { requestInit: { headers } } : {}),
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl as unknown as typeof fetch } : {}),
  });
  const client = new Client(
    { name: "opendexter-cli", version: VERSION },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    return await client.callTool({
      name: opts.toolName,
      arguments: opts.arguments ?? {},
    }) as CallToolResult;
  } finally {
    await client.close().catch(() => {});
  }
}

export function structuredToolResult(
  result: Pick<CallToolResult, "structuredContent" | "content">,
): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = Array.isArray(result.content)
    ? result.content.find((content) => content?.type === "text")?.text
    : undefined;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* A prose result has no structured projection. */
    }
  }
  return {};
}

export async function callHostedAccountTool<
  T extends Record<string, unknown> = Record<string, unknown>,
>(opts: {
  accessToken: string;
  toolName: "x402_wallet" | "dexter_portfolio";
  serverUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  return structuredToolResult(await callHostedTool({
    ...opts,
    arguments: {},
  })) as T;
}

export async function callHostedWalletTool(opts: {
  accessToken: string;
  serverUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<HostedWalletResult> {
  return callHostedAccountTool<HostedWalletResult>({
    ...opts,
    toolName: "x402_wallet",
  });
}

/** True when an error from the hosted call means "bearer rejected / expired". */
export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: unknown; name?: unknown; message?: unknown };
  if (anyErr.code === 401) return true;
  if (String(anyErr.name ?? "") === "UnauthorizedError") return true;
  return /\b401\b|unauthorized|token.?expired|invalid_token/i.test(String(anyErr.message ?? ""));
}

/**
 * Exchange the stored dlt_ refresh token for a fresh access token against the
 * connector rail. Returns null on any refusal or network failure (the caller
 * then tells the user to reconnect — it never retries blindly).
 */
export async function refreshVaultToken(opts: {
  refreshToken: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number } | null> {
  if (!opts.refreshToken) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiBase.replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${base}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: opts.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) return null;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
    };
  } catch {
    return null;
  }
}

export interface HostedRuntimeCallOpts {
  toolName: HostedRuntimeToolName;
  arguments?: Record<string, unknown>;
  dev?: boolean;
  dataDir?: string;
  serverUrl?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Safe for reads and pre-dispatch checks. x402_fetch must set this false:
   * once dispatch may have happened, an auth-looking failure is not proof that
   * no charge occurred and must never trigger an automatic second call.
   */
  retryRejectedBearer?: boolean;
  /** Test seam for the one hosted MCP call. */
  callHosted?: (
    accessToken: string | null,
    toolName: HostedRuntimeToolName,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
}

async function refreshAndPersistSession(
  session: VaultSession,
  opts: Pick<HostedRuntimeCallOpts, "apiBase" | "dev" | "fetchImpl" | "dataDir" | "now">,
): Promise<VaultSession | null> {
  const refreshed = await refreshVaultToken({
    refreshToken: session.refreshToken,
    apiBase: opts.apiBase ?? getApiBase(opts.dev ?? false),
    fetchImpl: opts.fetchImpl,
  });
  if (!refreshed) return null;
  const now = opts.now ?? (() => Date.now());
  const next = {
    ...session,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? session.refreshToken,
    expiresAt:
      now() + (refreshed.expiresIn && refreshed.expiresIn > 0
        ? refreshed.expiresIn
        : 3600) * 1000,
  } satisfies VaultSession;
  saveSession(next, opts.dataDir);
  return next;
}

/**
 * Call the hosted runtime selected by the current connect store. An absent
 * session may call only anonymous search/check; every account-bound tool fails
 * before dispatch. This path never reads or creates wallet.json. A stale token
 * is refreshed before dispatch. A rejected bearer is retried only for
 * explicitly retry-safe tools and never for fetch.
 */
export async function callHostedRuntimeTool(
  opts: HostedRuntimeCallOpts,
): Promise<CallToolResult> {
  const now = opts.now ?? (() => Date.now());
  const callHosted = opts.callHosted ?? ((accessToken, toolName, args) =>
    callHostedTool({
      accessToken,
      toolName,
      arguments: args,
      serverUrl: opts.serverUrl,
      fetchImpl: opts.fetchImpl,
    }));
  let session = loadSession(opts.dataDir);

  if (
    !session
    && opts.toolName !== "x402_search"
    && opts.toolName !== "x402_check"
  ) {
    throw new Error(`connect_required_for_hosted_${opts.toolName}`);
  }

  // Refresh before any dispatch when expiry is already known. This is safe for
  // x402_fetch because no consequential request has been sent yet.
  if (session && session.expiresAt <= now() + 30_000) {
    session = await refreshAndPersistSession(session, opts);
    if (!session) {
      throw new Error("connected_session_expired_reconnect_required");
    }
  }

  const args = opts.arguments ?? {};
  try {
    return await callHosted(session?.accessToken ?? null, opts.toolName, args);
  } catch (error) {
    if (!session || !isAuthError(error)) throw error;
    if (opts.retryRejectedBearer === false || opts.toolName === "x402_fetch") {
      throw new Error(
        "connected_session_rejected_no_automatic_retry; reconnect and reconcile the same intent before any retry",
      );
    }
    session = await refreshAndPersistSession(session, opts);
    if (!session) {
      throw new Error("connected_session_expired_reconnect_required");
    }
    return await callHosted(session.accessToken, opts.toolName, args);
  }
}

function unavailableAuthorityStatus(reason: string): RuntimeAuthorityStatus {
  return {
    ...projectRuntimeAuthorityStatus(null),
    reason,
  };
}

/**
 * Read exact live authority evidence with the stored OAuth bearer. The API
 * independently verifies aud=https://open.dexter.cash/mcp plus vault and
 * dexter_surface scopes and resolves durable server-side bindings; the client
 * sends no principal, grant, vault, role, or internal HMAC material.
 */
export async function readGovernedAuthorityStatus(opts: {
  dev?: boolean;
  dataDir?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
} = {}): Promise<RuntimeAuthorityStatus> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const apiBase = (opts.apiBase ?? getApiBase(opts.dev ?? false)).replace(/\/+$/, "");
  let session = loadSession(opts.dataDir);
  if (!session) return unavailableAuthorityStatus("connect_required");

  if (session.expiresAt <= now() + 30_000) {
    session = await refreshAndPersistSession(session, opts);
    if (!session) return unavailableAuthorityStatus("connected_session_expired");
  }

  const read = async (accessToken: string): Promise<Response> =>
    fetchImpl(`${apiBase}${GOVERNED_AUTHORITY_STATUS_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

  try {
    let response = await read(session.accessToken);
    if (response.status === 401) {
      const refreshed = await refreshAndPersistSession(session, opts);
      if (!refreshed) return unavailableAuthorityStatus("connected_session_expired");
      session = refreshed;
      response = await read(session.accessToken);
    }
    if (!response.ok) {
      return unavailableAuthorityStatus(
        response.status === 403
          ? "governed_authority_scope_unavailable"
          : "governed_authority_status_unavailable",
      );
    }
    const body = await response.json().catch(() => null);
    const evidence = objectValue(body);
    if (!evidence) return unavailableAuthorityStatus("governed_authority_status_invalid");
    return projectRuntimeAuthorityStatus({ authority: evidence });
  } catch {
    return unavailableAuthorityStatus("governed_authority_status_unavailable");
  }
}

/** Add local runtime truth without replacing any provider payload or receipt. */
export function attachRuntimeAuthorityStatus(
  result: CallToolResult,
  status: RuntimeAuthorityStatus,
): CallToolResult {
  const structuredContent = {
    ...structuredToolResult(result),
    runtimeAuthority: status,
  };
  let replacedText = false;
  const content = result.content.map((block) => {
    if (!replacedText && block.type === "text") {
      replacedText = true;
      return { ...block, text: JSON.stringify(structuredContent, null, 2) };
    }
    return block;
  });
  if (!replacedText) {
    content.unshift({ type: "text", text: JSON.stringify(structuredContent, null, 2) });
  }
  return {
    ...result,
    content,
    structuredContent,
  };
}

export interface ConnectedWalletOpts {
  session: VaultSession;
  dev?: boolean;
  dataDir?: string;
  log?: (line: string) => void;
  now?: () => number;
  serverUrl?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Test seam — the hosted x402_wallet call (default: real MCP client). */
  callHostedWallet?: (accessToken: string) => Promise<HostedWalletResult>;
  /** Test seam — exact bearer-authenticated governed authority read. */
  readAuthorityStatus?: () => Promise<RuntimeAuthorityStatus>;
}

/**
 * The connected-mode `opendexter wallet` body: call the hosted wallet tool,
 * refresh-and-retry once on a 401, then render the deposit address + balance.
 */
export async function showConnectedWallet(opts: ConnectedWalletOpts): Promise<void> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => Date.now());
  const serverUrl = opts.serverUrl ?? HOSTED_MCP_URL;
  const apiBase = opts.apiBase ?? getApiBase(opts.dev ?? false);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const callHosted =
    opts.callHostedWallet ??
    ((accessToken: string) => callHostedWalletTool({ accessToken, serverUrl, fetchImpl }));

  let session = opts.session;
  let result: HostedWalletResult;

  try {
    result = await callHosted(session.accessToken);
  } catch (err) {
    if (!isAuthError(err)) {
      // Transport/server hiccup — not an auth problem. Don't touch the session.
      log("Couldn't reach your Dexter vault just now. Try `opendexter wallet` again in a moment.");
      return;
    }
    // Bearer rejected — refresh once, persist, retry a single time.
    const refreshed = await refreshVaultToken({
      refreshToken: session.refreshToken,
      apiBase,
      fetchImpl,
    });
    if (!refreshed) {
      log("Your session expired — run `opendexter connect` again.");
      return;
    }
    session = {
      ...session,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? session.refreshToken,
      expiresAt:
        now() + (refreshed.expiresIn && refreshed.expiresIn > 0 ? refreshed.expiresIn : 3600) * 1000,
    };
    saveSession(session, opts.dataDir);
    try {
      result = await callHosted(session.accessToken);
    } catch {
      log("Your session expired — run `opendexter connect` again.");
      return;
    }
  }

  const embeddedAuthority = projectRuntimeAuthorityStatus(result);
  const endpointAuthority = opts.readAuthorityStatus
    ? await opts.readAuthorityStatus()
    : opts.callHostedWallet
      ? embeddedAuthority
      : await readGovernedAuthorityStatus({
          dev: opts.dev,
          dataDir: opts.dataDir,
          apiBase: opts.apiBase,
          fetchImpl,
          now,
        });
  const authority = endpointAuthority.evidenceNamespace
    ? endpointAuthority
    : embeddedAuthority.evidenceNamespace
      ? embeddedAuthority
      : endpointAuthority;
  renderConnectedWallet(result, authority, log);
}

/** Atomic (6-dp) USDC string → number, or null when unparseable. */
function atomicToUsdc(atomic: string | undefined | null): number | null {
  if (atomic == null) return null;
  const n = Number(atomic);
  if (!Number.isFinite(n)) return null;
  return n / 1e6;
}

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Read activation state from whatever shape the hosted result carries. */
function readActivated(result: HostedWalletResult): boolean | null {
  if (typeof result.activated === "boolean") return result.activated;
  const a = result.activation;
  if (typeof a === "boolean") return a;
  if (a && typeof a === "object" && typeof a.activated === "boolean") return a.activated;
  return null;
}

/**
 * Apple-polished, no-emoji render of the connected vault. The deposit address
 * is always the hosted result's `address` (the wallet-PDA) — never the
 * dexter.vault state address on the session.
 */
function renderConnectedWallet(
  result: HostedWalletResult,
  authority: RuntimeAuthorityStatus,
  log: (line: string) => void,
): void {
  // The session is connected, but the vault itself isn't set up yet — a user
  // who ran `connect` before finishing wallet setup. Guide them to finish;
  // never imply a service outage (that message is for a genuine no-data read).
  if (result.vault_status === "not_enrolled" || result.mode === "vault_required") {
    const setupUrl = result.enroll_url || result.pairing_url || "https://dexter.cash/wallet";
    log("");
    log("Dexter Wallet connected runtime");
    log("  x402 path: hosted governed runtime");
    log("");
    log("  Your wallet isn't set up yet.");
    log(`  Finish setup at ${setupUrl}`);
    log("  then run `opendexter wallet` again.");
    log("");
    renderAuthority(authority, log);
    return;
  }

  const address = result.address || result.solanaAddress || null;
  const usdc =
    typeof result.balances?.usdc === "number"
      ? result.balances.usdc
      : atomicToUsdc(result.balances?.availableAtomic);
  const degraded = result.balances?.degraded === true;
  const activated = readActivated(result);

  log("");
  log("Dexter Wallet connected runtime");
  log("  x402 path: hosted governed runtime");

  log("");
  log("  USDC balance");
  if (usdc == null) {
    log("    unavailable — the balance service didn't respond. Try again shortly.");
  } else {
    log(`    ${formatUsd(usdc)}${degraded ? "  (some chains unverified)" : ""}`);
  }

  if (address) {
    log("");
    log("  Deposit address");
    log(`    ${address}`);
  }

  if (activated === false) {
    log("");
    log("  Your vault activates automatically on your first deposit.");
  }

  renderAuthority(authority, log);
}

function renderAuthority(
  authority: RuntimeAuthorityStatus,
  log: (line: string) => void,
): void {
  log("");
  log("  Governed x402 authority");
  log(`    status: ${authority.status}`);
  log(`    source: ${authority.authoritySource ?? "unavailable"}`);
  log(`    grant: ${authority.grantId ?? "unavailable"}`);
  log(`    grant revision: ${authority.grantRevision ?? "unavailable"}`);
  log(`    logical grant active: ${authority.logicalGrantActive ?? "unavailable"}`);
  log(`    principal: ${authority.principal ? JSON.stringify(authority.principal) : "unavailable"}`);
  log(`    limits: ${authority.limits ? JSON.stringify(authority.limits) : "unavailable"}`);
  log(`    remaining: ${authority.remaining ? JSON.stringify(authority.remaining) : "unavailable"}`);
  log(`    expiry: ${authority.expiresAt ?? "unavailable"}`);
  log(`    scopes: ${authority.scopes ? JSON.stringify(authority.scopes) : "unavailable"}`);
  log(`    active role: ${authority.activeRole ? JSON.stringify(authority.activeRole) : "unavailable"}`);
  log(
    `    revocation: ${authority.revocation.revoked === null
      ? "unavailable"
      : authority.revocation.revoked
        ? "revoked"
        : "not revoked"}`,
  );
  if (authority.reason) log(`    reason: ${authority.reason}`);
  log("");
  log("  Local signer execution: unavailable (legacy wallet recovery is view-only)");
  log("  Automatic fallback: never");
  log("  Manage or revoke at https://dexter.cash/wallet");
}
