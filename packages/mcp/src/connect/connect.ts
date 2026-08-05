/**
 * `opendexter connect` — bind this CLI to the user's real Dexter vault.
 *
 * The user-facing centerpiece. Runs the RFC 8628 OAuth Device Authorization
 * Grant against dexter-api's connector rail: POST /device_authorization to get a
 * device_code + human user_code, present THREE browser-optional approval paths
 * (link, terminal QR, hand-typed code), then poll /token with
 * grant_type=device_code until the user approves with their passkey on any
 * device. On success we persist the returned vault token pair via the atomic
 * session store so the local MCP and CLI can use the same hosted governed x402
 * runtime without re-authenticating. wallet.json and environment signers are
 * never payment executors. Existing wallet.json users retain only an explicit
 * read-only public-address and balance recovery view.
 *
 * The CLI never handles a password, private key, or passkey ceremony — OAuth is
 * only the transport; approval happens in the browser at
 * dexter.cash/wallet/connect. The device_code held here is a one-time
 * capability; the access_token it yields is a bearer credential, so this file
 * follows the same custody discipline as the store it writes to.
 */

import { getApiBase } from "../config.js";
import { tryOpenInBrowser, renderQr } from "../util/browser.js";
import { saveSession, loadSession, clearSession, type VaultSession } from "./store.js";
import {
  readGovernedAuthorityStatus,
  type RuntimeAuthorityStatus,
} from "./wallet.js";

/** RFC 8628 §3.4 grant_type for the device_code poll. */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** The client_id the connector rail knows this CLI by. */
const CLIENT_ID = "opendexter-cli";
const DEVICE_LABEL = "opendexter-cli";
/** Account view plus server-resolved governed-surface authority evidence. */
const CONNECT_SCOPE = "vault dexter_surface";
/** Where the human approves — printed alongside the typed user_code. */
const VERIFICATION_PAGE = "dexter.cash/wallet/connect";
/** Slow-down back-off step (RFC 8628 §3.5: bump the interval, keep polling). */
const SLOW_DOWN_STEP_SECONDS = 5;

export interface ConnectOpts {
  /** Use localhost dexter-api instead of production. */
  dev?: boolean;
  /** Never try to spawn a browser — print link + QR + code only (headless). */
  noBrowser?: boolean;

  // ── Test seams (never set by the CLI) ──────────────────────────────────────
  /** Session-store directory override. */
  dataDir?: string;
  /** Output sink (default console.log). */
  log?: (line: string) => void;
  /** HTTP client (default global fetch). */
  fetchImpl?: typeof fetch;
  /** Browser opener (default tryOpenInBrowser). */
  openBrowser?: (url: string) => boolean;
  /** QR renderer (default renderQr). */
  renderQrImpl?: (url: string) => string;
  /** Delay between polls (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock (default Date.now). */
  now?: () => number;
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * Decode a JWT's PAYLOAD segment for DISPLAY only — no signature check, because
 * this is the CLI's OWN token: we minted the request, we received the response
 * over TLS, and we only read it to show the user which vault they connected.
 * Returns null on any malformation (the caller degrades to "unknown vault").
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pull the vault address (dexter.vault) and identity root (sub) off the token. */
function readVaultIdentity(accessToken: string): { vaultAddress: string; vaultPda: string } {
  const payload = decodeJwtPayload(accessToken);
  const dexter =
    payload && typeof payload.dexter === "object" && payload.dexter
      ? (payload.dexter as Record<string, unknown>)
      : null;
  const vaultAddress = dexter && typeof dexter.vault === "string" ? dexter.vault : "";
  // The vault token carries no on-chain PDA; `sub` is the passkey handle (the
  // identity root), which is the session's stable per-vault key. Persisted in
  // the store's vaultPda slot per the token's claim shape.
  const vaultPda = payload && typeof payload.sub === "string" ? payload.sub : "";
  return { vaultAddress, vaultPda };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

const RULE = "──────────────────────────────────────────────────────────";

export async function cliConnect(opts: ConnectOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const openBrowser = opts.openBrowser ?? tryOpenInBrowser;
  const qr = opts.renderQrImpl ?? renderQr;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const base = getApiBase(opts.dev ?? false).replace(/\/+$/, "");

  // ── 1. Kick off the device flow ───────────────────────────────────────────
  let auth: DeviceAuthorization;
  try {
    const res = await fetchImpl(`${base}/api/connector/oauth/device_authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: CONNECT_SCOPE }),
    });
    const body = (await res.json().catch(() => ({}))) as DeviceAuthorization & { error?: string };
    if (!res.ok || !body.device_code || !body.user_code) {
      log(`Couldn't start the connect flow (HTTP ${res.status}${body.error ? `: ${body.error}` : ""}).`);
      log("Check your connection and try `opendexter connect` again.");
      return;
    }
    auth = body;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Couldn't reach Dexter to start the connect flow: ${msg}`);
    return;
  }

  // ── 2. Present all three approval paths (browser-optional is a constraint) ──
  log("");
  log(`── Connect your Dexter wallet ${RULE.slice(0, 30)}`);
  log("Approve with your passkey — any one of these, on any device:");
  log("");
  log("  1. Open this link:");
  log(`     ${auth.verification_uri_complete}`);
  log("");

  const rendered = qr(auth.verification_uri_complete);
  if (rendered) {
    log("  2. Or scan this QR code:");
    log("");
    log(rendered);
  }

  log(`  3. Or enter this code at ${VERIFICATION_PAGE} on any device:`);
  log("");
  log(`     ${auth.user_code}`);
  log("");

  if (!opts.noBrowser) {
    const opened = openBrowser(auth.verification_uri_complete);
    if (opened) log("Opened the approval page in your browser.");
  }

  // ── 3. Poll /token until approval, expiry, or the overall deadline ─────────
  log("");
  log("Waiting for approval (Ctrl-C is safe — re-run `opendexter connect` to retry)…");

  let intervalSeconds = auth.interval && auth.interval > 0 ? auth.interval : 5;
  const deadline = now() + (auth.expires_in && auth.expires_in > 0 ? auth.expires_in : 600) * 1000;
  let warnedNetwork = false;

  while (now() < deadline) {
    let token: TokenResponse;
    let ok = false;
    let httpStatus = 0;
    try {
      const res = await fetchImpl(`${base}/api/connector/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: auth.device_code,
          client_id: CLIENT_ID,
        }),
      });
      ok = res.ok;
      httpStatus = res.status;
      token = (await res.json().catch(() => ({}))) as TokenResponse;
    } catch (err: unknown) {
      // A transient network blip must not kill the ceremony — the approval may
      // land while we retry. Warn once (loudly), then keep polling.
      if (!warnedNetwork) {
        warnedNetwork = true;
        const msg = err instanceof Error ? err.message.split("\n")[0].slice(0, 120) : String(err);
        log(`(Network hiccup while polling — still waiting: ${msg})`);
      }
      await sleep(intervalSeconds * 1000);
      continue;
    }

    if (ok && token.access_token) {
      await finishConnect(token, { log, now, dataDir: opts.dataDir });
      return;
    }

    switch (token.error) {
      case "authorization_pending":
        break; // keep waiting
      case "slow_down":
        intervalSeconds += SLOW_DOWN_STEP_SECONDS;
        break;
      case "expired_token":
        log("");
        log("This request expired before it was approved. Run `opendexter connect` again.");
        return;
      case "invalid_grant":
        log("");
        log("This connect request is no longer valid. Run `opendexter connect` again.");
        return;
      default:
        // Unknown / server_error (e.g. HTTP 500): could be transient — warn once
        // and keep polling until the deadline rather than abandoning a possibly
        // in-flight approval.
        if (!warnedNetwork) {
          warnedNetwork = true;
          log(`(Server hiccup while polling — still waiting${token.error ? `: ${token.error}` : ` (HTTP ${httpStatus})`})`);
        }
        break;
    }

    await sleep(intervalSeconds * 1000);
  }

  log("");
  log("No approval came through in time. The link is expired — run `opendexter connect` to start over.");
}

async function finishConnect(
  token: TokenResponse,
  ctx: { log: (line: string) => void; now: () => number; dataDir?: string },
): Promise<void> {
  const accessToken = token.access_token as string;
  const { vaultAddress, vaultPda } = readVaultIdentity(accessToken);
  const expiresInSeconds = token.expires_in && token.expires_in > 0 ? token.expires_in : 3600;

  const session: VaultSession = {
    version: 1,
    accessToken,
    refreshToken: token.refresh_token ?? "",
    vaultAddress,
    vaultPda,
    // Epoch milliseconds (matches the store's Date.now()-based convention).
    expiresAt: ctx.now() + expiresInSeconds * 1000,
    deviceLabel: DEVICE_LABEL,
  };
  saveSession(session, ctx.dataDir);

  ctx.log("");
  ctx.log("Connected your Dexter Wallet to the hosted governed x402 runtime");
  if (vaultAddress) ctx.log(`  ${vaultAddress}`);
  ctx.log("");
  ctx.log("Run `opendexter connect status` to verify the active grant, limits, remaining capacity, expiry, scopes, and revocation state.");
  ctx.log("No bounded payment authority is claimed until that live status read proves it.");
  ctx.log("Local wallet.json/environment signers are not payment executors on this runtime.");
  ctx.log("Revoke anytime at dexter.cash/wallet.");
}

export interface ConnectStatusOpts {
  dataDir?: string;
  log?: (line: string) => void;
  dev?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test seam for exact status evidence. */
  readAuthorityStatus?: () => Promise<RuntimeAuthorityStatus>;
}

export async function cliConnectStatus(opts: ConnectStatusOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const session = loadSession(opts.dataDir);
  if (!session) {
    log("Not connected.");
    return;
  }
  const authority = opts.readAuthorityStatus
    ? await opts.readAuthorityStatus()
    : await readGovernedAuthorityStatus({
        dataDir: opts.dataDir,
        dev: opts.dev,
        fetchImpl: opts.fetchImpl,
        now: opts.now,
      });
  log("Dexter Wallet connected runtime");
  log(`  ${session.vaultAddress}`);
  log("x402 path: hosted governed runtime");
  log(`Authority status: ${authority.status}`);
  log(`Authority source: ${authority.authoritySource ?? "unavailable"}`);
  log(`Grant ID: ${authority.grantId ?? "unavailable"}`);
  log(`Grant revision: ${authority.grantRevision ?? "unavailable"}`);
  log(`Logical grant active: ${authority.logicalGrantActive ?? "unavailable"}`);
  log(`Principal: ${authority.principal ? JSON.stringify(authority.principal) : "unavailable"}`);
  log(`Limits: ${authority.limits ? JSON.stringify(authority.limits) : "unavailable"}`);
  log(`Remaining: ${authority.remaining ? JSON.stringify(authority.remaining) : "unavailable"}`);
  log(`Expiry: ${authority.expiresAt ?? "unavailable"}`);
  log(`Scopes: ${authority.scopes ? JSON.stringify(authority.scopes) : "unavailable"}`);
  log(`Active role: ${authority.activeRole ? JSON.stringify(authority.activeRole) : "unavailable"}`);
  log(
    `Revocation: ${authority.revocation.revoked === null
      ? "unavailable"
      : authority.revocation.revoked
        ? "revoked"
        : "not revoked"}`,
  );
  if (authority.reason) log(`Reason: ${authority.reason}`);
  log("Local signer fallback: unavailable; automatic fallback: never.");
}

export async function cliConnectDisconnect(opts: ConnectStatusOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  clearSession(opts.dataDir);
  log("Disconnected.");
}
