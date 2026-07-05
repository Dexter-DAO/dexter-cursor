/**
 * The tab lane — tab-first payment for every paid call this CLI makes.
 *
 * Wiring: x402Fetch (the single paid path shared by the `opendexter fetch`
 * CLI command and the MCP server's x402_fetch/x402_pay tools) offers every
 * parsed 402 to this hook BEFORE the generic exact path. The lane pays by
 * voucher iff the 402 offers scheme 'tab' AND this CLI custodies an ACTIVE
 * grant for that seller; otherwise it falls through — exact behaves exactly
 * as it did before tabs existed, with a loud `tab` note where one is due
 * (no-silent-fallbacks).
 *
 * Consent is structural: the lane can only ever spend through a session key
 * the human passkey-approved on dexter.cash (the program verifies the
 * passkey ceremony inside the register tx — the CLI cannot mint spending
 * authority, only ask for it).
 *
 * THE IN-BAND OFFER (T2b): the consent flow comes TO the user inside their
 * agent, the same way the open MCP's vault_required funnel does. When the
 * seller offers scheme 'tab' and no grant exists, the lane mints + persists
 * a session key (0600, atomic, BEFORE the link leaves the process) and
 * returns offer materials; x402Fetch composes the agent-facing shape —
 * attached alongside the exact result for a dual-rail seller (the call is
 * never blocked on consent), or as the whole response for a tab-only
 * seller. While the grant is pending, each call makes ONE bounded chain
 * read: the moment the human approves, the very next call rides the tab.
 * `opendexter tab connect` remains the power-user path; it is never
 * required.
 *
 * OFFER SUPPRESSION: the relayable offer is shown once per (process,
 * seller) — in-memory, most-recent only, cleared on restart. Later calls
 * carry a terse `tab` note instead (no-silent-fallbacks). Tab-only sellers
 * are exempt: there the offer is the call's only possible answer.
 *
 * FAILURE DOCTRINE (who falls through, who errors loudly):
 *  - No grant / pending grant / policy cap below price / dead session
 *    → fall through to exact WITH a note (or the offer above). No voucher
 *    was signed; paying exact is safe and is what the pre-tab CLI did.
 *  - Voucher SIGNED and the seller refused it (second 402), or the wire
 *    failed after dispatch → FINAL loud error, never a quiet exact retry.
 *    A signed voucher is a bearer claim; the refusal reasons are surfaced
 *    with their remediation (see explainRefusal). `--no-tab` /
 *    `noTab: true` is the explicit escape hatch.
 */

import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import type {
  TabLaneHook,
  TabLaneOutcome,
  TabLaneRequest,
  TabOfferMaterials,
  BudgetRuntime,
} from "@dexterai/x402-mcp-tools";
import type { Tab, SignedVoucher } from "@dexterai/x402/tab";
import { SOLANA_RPC_URL } from "../config.js";
import { findTab, updateTab, type TabRecord } from "./store.js";
import { consentLinkFor, mintPendingTab } from "./connect.js";
import { findSessionByAgentKey } from "./chain.js";

const USDC_DECIMALS = 6;

/** Definitive dead-grant error prefixes from tabFromGrant — safe to mark
 *  the stored record dead on (transient RPC errors never match these). All
 *  are deterministic verdicts about the STORED grant, so retrying
 *  construction every call would just re-throw the same error and burn RPC. */
const DEAD_GRANT_ERRORS = [
  "tab_session_not_live",
  "tab_session_pubkey_mismatch",
  "tab_grant_params_stale",
  "tab_exhausted",
  // The SDK's definitive wrong-key verdict: the custodied secret does not
  // sign for params.sessionPubkey (a corrupted/mis-stored record). It can
  // never construct — mark dead so `tab connect --rekey` is the next step,
  // not a per-call re-throw.
  "tab_session_key_mismatch",
];

export interface TabLaneDeps {
  /** Custody dir override (tests). Default: ~/.dexterai-mcp */
  dataDir?: string;
  /** RPC connection for tabFromGrant's frontier/arming reads. */
  connection?: Connection;
  /** Facilitator override (tests). Default: the SDK's DEFAULT_FACILITATOR_URL. */
  facilitatorUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-call USDC cap — same policy the exact path enforces. */
  getMaxAmountUsdc?: () => number;
  /** Rolling 24h budget hooks — same velocity guard as the exact path. */
  getBudgetRuntime?: () => BudgetRuntime | undefined;
}

/**
 * In-process open tabs keyed by counterparty. In the long-running MCP
 * server this is what turns call 2..N into pure-local voucher signatures
 * on one channel; in the one-shot CLI it is trivially per-invocation.
 * Module-level so every lane instance shares one tab per seller —
 * `tabFromGrant`'s TOCTOU doctrine wants ONE holder per (vault, seller)
 * per process.
 */
const openTabs = new Map<string, Tab>();

/**
 * Sellers whose in-band tab offer was already relayed this process, keyed
 * by counterparty. In-memory and most-recent only, by design: a restart
 * re-offers once, and later calls in the same process carry a terse note
 * instead of repeating the invitation. Tab-only sellers bypass this — the
 * offer is their only possible answer.
 */
const offeredTabs = new Set<string>();

export function resetTabLaneCacheForTests(): void {
  openTabs.clear();
  offeredTabs.clear();
}

/** One bounded chain read while a grant is pending — never a poll loop
 *  inside a tool call. On timeout the call treats the grant as still
 *  pending; the next call reads again. */
const GRANT_CHECK_TIMEOUT_MS = 4_000;

async function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("grant_check_timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every accept in the 402 is scheme 'tab' — no exact rail exists. */
function isTabOnly(requirements: Record<string, unknown> | null): boolean {
  const accepts = Array.isArray(requirements?.accepts)
    ? (requirements!.accepts as Array<Record<string, unknown>>)
    : [];
  return accepts.length > 0 && accepts.every((a) => a.scheme === "tab");
}

/**
 * Return the in-band offer for a record awaiting consent — or, when the
 * offer was already relayed this process and an exact rail exists, the
 * terse suppression note (the invitation shows once, the fallback stays
 * loud).
 */
function offerOutcome(
  mode: TabOfferMaterials["mode"],
  record: TabRecord,
  priceUsdc: number,
  requirements: Record<string, unknown> | null,
): TabLaneOutcome {
  const connectUrl = consentLinkFor(record.sellerUrl, record.sessionPubkey);
  if (!isTabOnly(requirements) && offeredTabs.has(record.counterparty)) {
    return {
      done: false,
      note: {
        rail: "tab",
        used: false,
        reason:
          "a tab with this seller is awaiting the human's approval (offer already shown this session) — paid exact instead",
        approveUrl: connectUrl,
      },
    };
  }
  offeredTabs.add(record.counterparty);
  return {
    done: false,
    offer: {
      mode,
      connectUrl,
      ...(Number.isFinite(priceUsdc) ? { priceUsdcPerCall: priceUsdc } : {}),
    },
  };
}

function atomicToUsdc(atomic: string, decimals = USDC_DECIMALS): number {
  const n = Number(atomic);
  return Number.isFinite(n) ? n / Math.pow(10, decimals) : NaN;
}

interface TabAccept {
  payTo: string;
  amountAtomic: string;
  decimals: number;
  voucherHeader: string;
}

/** Extract the tab accept from parsed 402 requirements (SVM only — tabs are
 *  a Solana-mainnet scheme; the wire carries the CAIP-2 genesis-hash form). */
function findTabAccept(requirements: Record<string, unknown> | null): TabAccept | null {
  const accepts = Array.isArray(requirements?.accepts)
    ? (requirements!.accepts as Array<Record<string, unknown>>)
    : [];
  const accept = accepts.find(
    (a) => a.scheme === "tab" && String(a.network ?? "").startsWith("solana"),
  );
  if (!accept || typeof accept.payTo !== "string") return null;
  const amount = accept.amount ?? accept.maxAmountRequired;
  if (amount == null || amount === "") return null;
  const extra =
    accept.extra && typeof accept.extra === "object"
      ? (accept.extra as Record<string, unknown>)
      : {};
  return {
    payTo: accept.payTo,
    amountAtomic: String(amount),
    decimals: Number(extra.decimals ?? USDC_DECIMALS),
    voucherHeader: String(extra.voucherHeader ?? "x-tab-voucher"),
  };
}

/**
 * The item-5 reason table: seller `invalid_voucher` reasons → what actually
 * happened + what to do. Voucher refusals are FINAL results — the same
 * voucher will be refused again, and paying exact silently would hide a
 * broken tab lane behind per-call payments forever.
 */
function explainRefusal(reason: string, detail: string | undefined, sellerUrl: string): string {
  switch (reason) {
    case "cumulative_exceeds_cap":
      // SELLER-SIDE OVER-DELIVERY NUANCE (tab-lane brief item 5): a resumed
      // session presents its first voucher with cumulative > 0 — the whole
      // chain frontier plus this call's increment arrives as ONE increment
      // on a fresh channel (tabFromGrant derives a new channelId per
      // process; the durable counter is the chain, not a local store). The
      // seller bounds any single voucher's increment at maxPerVoucher
      // (default perUnit x 100) to cap what an over-large first cumulative
      // could make it deliver, so a long-lived tab eventually outgrows the
      // seller's resume window. That is a terminal state for THIS tab, not
      // a retryable blip.
      return (
        `The seller refused the tab voucher: cumulative_exceeds_cap` +
        (detail ? ` (${detail})` : "") +
        `. Either the tab's total cap is exhausted, or this is a RESUME ` +
        `whose first voucher (chain frontier + this call) exceeds the ` +
        `seller's per-voucher bound — sellers cap single-voucher increments ` +
        `to limit over-delivery on resumed sessions. Do NOT retry: the same ` +
        `voucher will be refused again. Recover by opening a FRESH tab with a ` +
        `new key — \`opendexter tab connect ${sellerUrl} --rekey\` (or ` +
        `\`opendexter tab remove ${sellerUrl}\` then ` +
        `\`opendexter tab connect ${sellerUrl}\`); reopening is a new grant ` +
        `on a new channel that resumes cleanly over the chain frontier. To ` +
        `pay just this one call without a tab: \`opendexter fetch ${sellerUrl} ` +
        `--no-tab\` (CLI) or the tab:false arg on x402_fetch.`
      );
    case "non_monotonic":
      return (
        `The seller refused the tab voucher: non_monotonic` +
        (detail ? ` (${detail})` : "") +
        `. The seller has already accepted vouchers beyond the on-chain ` +
        `frontier this process resumed from — usually crystallization lag ` +
        `(seconds), or ANOTHER process is driving the same tab. Wait a few ` +
        `seconds and call again (a fresh frontier read happens on the next ` +
        `call); make sure only one process uses this tab at a time.`
      );
    case "channel_busy":
      return (
        `The seller refused the tab voucher: channel_busy — another request ` +
        `is in flight on this tab's channel. Tabs serialize: one request at ` +
        `a time per seller. Retry after the in-flight request finishes.`
      );
    case "session_expired":
      return (
        `The seller refused the tab voucher: session_expired — the tab's ` +
        `consented expiry has passed. Open a fresh tab: ` +
        `\`opendexter tab connect ${sellerUrl} --rekey\`.`
      );
    default:
      return (
        `The seller refused the tab voucher: ${reason}` +
        (detail ? ` (${detail})` : "") +
        `. Not retried — inspect the reason; \`opendexter tab connect ` +
        `${sellerUrl} --rekey\` opens a fresh tab, \`--no-tab\` (or the ` +
        `x402_fetch tab:false arg) pays this call exact.`
      );
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    try {
      return await res.json();
    } catch {
      /* fall through to text */
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

export function createTabLane(deps: TabLaneDeps = {}): TabLaneHook {
  const dir = deps.dataDir;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let connection: Connection | null = deps.connection ?? null;
  const getConnection = () => {
    if (!connection) connection = new Connection(SOLANA_RPC_URL, "confirmed");
    return connection;
  };

  return async (request: TabLaneRequest, requirements) => {
    const tabAccept = findTabAccept(requirements);
    if (!tabAccept) return { done: false }; // seller doesn't take tabs — nothing to say

    // ── Policy gates (same caps the exact path enforces) ──────────────
    // Hoisted above the grant lookup: they gate paying AND offering — an
    // offer for a tab the per-call cap would never let sign is spam.
    const priceUsdc = atomicToUsdc(tabAccept.amountAtomic, tabAccept.decimals);
    const cap = deps.getMaxAmountUsdc?.() ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(priceUsdc) || priceUsdc > cap) {
      return {
        done: false,
        note: {
          rail: "tab",
          used: false,
          reason: `tab skipped: seller price $${priceUsdc} exceeds the per-call cap $${cap}`,
        },
      };
    }
    const budget = deps.getBudgetRuntime?.();
    if (budget && budget.dailyBudgetUsdc > 0 && budget.spentLast24hUsdc + priceUsdc > budget.dailyBudgetUsdc) {
      return {
        done: false,
        note: {
          rail: "tab",
          used: false,
          reason: `tab skipped: this call would exceed the rolling 24h budget`,
        },
      };
    }

    let record = findTab(tabAccept.payTo, dir);

    // ── No grant at all: mint a session key and make the in-band offer ─
    // Custody first, link second: the keypair is generated and persisted
    // (0700 dir / 0600 file, atomic) BEFORE the consent link exists. The
    // link and the offer carry only the public key.
    if (!record) {
      const minted = mintPendingTab(request.url, tabAccept.payTo, dir);
      return offerOutcome("tab_available", minted, priceUsdc, requirements);
    }

    // ── Dead grant: fall through to exact, loudly — and no auto re-offer.
    // The chain said this session is gone; it may have been deliberately
    // revoked, and re-inviting after a revocation is spam. Reconnecting
    // stays a human decision (`opendexter tab connect`), and a dead record
    // can hold an unsettled receipt a fresh key could never settle.
    if (record.status === "dead") {
      return {
        done: false,
        note: {
          rail: "tab",
          used: false,
          reason: `stored tab is dead (${record.deadReason ?? "unknown"}) — paid exact instead`,
          connect: `opendexter tab connect ${request.url}`,
        },
      };
    }

    // ── Pending grant: ONE bounded chain read — the human may have just
    // approved on dexter.cash. Found live → promote and ride the tab THIS
    // call (this is the retry the offer's instructions promised). Not
    // found → still pending; say so via the offer materials. Read failed →
    // treat as pending, honestly; the next call reads again.
    if (record.status === "pending") {
      let found: Awaited<ReturnType<typeof findSessionByAgentKey>> = null;
      try {
        found = await bounded(
          findSessionByAgentKey(getConnection(), record.sessionPubkey, record.counterparty),
          GRANT_CHECK_TIMEOUT_MS,
        );
      } catch {
        found = null;
      }
      if (found && found.live) {
        const patch = {
          status: "active" as const,
          vaultPda: found.vaultPda,
          params: found.params,
          sessionPda: found.sessionPda,
          activatedAt: new Date().toISOString(),
        };
        updateTab(record.counterparty, patch, dir);
        record = { ...record, ...patch };
        // Fall through to the active path below — this call pays on the tab.
      } else if (found && !found.live) {
        updateTab(
          record.counterparty,
          { status: "dead", deadReason: "session registered but not live (expired or revoked before first use)" },
          dir,
        );
        return {
          done: false,
          note: {
            rail: "tab",
            used: false,
            reason: "the registered tab is not live on chain (expired or revoked before first use) — paid exact instead",
          },
        };
      } else {
        return offerOutcome("tab_pending", record, priceUsdc, requirements);
      }
    }

    // ── Construct (or reuse) the tab ───────────────────────────────────
    let tab = openTabs.get(record.counterparty);
    if (!tab) {
      if (!record.params || !record.vaultPda) {
        return {
          done: false,
          note: {
            rail: "tab",
            used: false,
            reason: "stored tab record is incomplete — re-run `opendexter tab connect`",
            connect: `opendexter tab connect ${request.url}`,
          },
        };
      }
      try {
        const { tabFromGrant } = await import("@dexterai/x402/tab");
        tab = await tabFromGrant({
          sessionSecretKey: bs58.decode(record.sessionSecretKey),
          params: {
            counterparty: record.counterparty,
            sessionPubkey: record.sessionPubkey,
            ...record.params,
          },
          vaultPda: record.vaultPda,
          connection: getConnection(),
          // Blast radius of ONE voucher against a misbehaving seller: the
          // per-call policy cap when finite, else exactly this call's price.
          perUnitCapAtomic: String(
            Number.isFinite(cap)
              ? Math.round(cap * Math.pow(10, USDC_DECIMALS))
              : tabAccept.amountAtomic,
          ),
          sellerUrl: record.sellerUrl,
          ...(deps.facilitatorUrl ? { facilitatorUrl: deps.facilitatorUrl } : {}),
        });
        openTabs.set(record.counterparty, tab);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const definitive = DEAD_GRANT_ERRORS.find((code) => msg.startsWith(code));
        if (definitive) {
          // The chain says this grant is gone/drifted — remember that so
          // `tab list` shows it and future calls skip the RPC round-trip.
          updateTab(record.counterparty, { status: "dead", deadReason: msg }, dir);
        }
        // Nothing was signed — exact is safe. Loud note either way.
        return {
          done: false,
          note: {
            rail: "tab",
            used: false,
            reason: `tab unavailable (${msg}) — paid exact instead`,
            connect: `opendexter tab connect ${request.url}`,
          },
        };
      }
    }

    // ── Sign the voucher and re-issue the request ──────────────────────
    let signed: SignedVoucher;
    try {
      signed = await tab.signNextVoucher(tabAccept.amountAtomic);
    } catch (err: unknown) {
      // Signing refused client-side (scope exceeded / expired / closed) —
      // no voucher exists, exact is safe. Drop the tab so the next call
      // reconstructs against a fresh frontier.
      openTabs.delete(record.counterparty);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        done: false,
        note: {
          rail: "tab",
          used: false,
          reason: `tab could not sign this voucher (${msg}) — paid exact instead`,
        },
      };
    }

    const { voucherToHeader } = await import("@dexterai/x402/tab");
    const headers: Record<string, string> = {
      ...(request.headers ?? {}),
      [tabAccept.voucherHeader]: voucherToHeader(signed),
    };
    const init: RequestInit = { method: request.method || "GET", headers };
    if (typeof request.body === "string" && request.method !== "GET") {
      init.body = request.body;
    }

    let res: Response;
    try {
      res = await fetchImpl(request.url, init);
    } catch (err: unknown) {
      // The voucher may have REACHED the seller — quietly paying exact on
      // top could double-pay this request (same doctrine as the SDK's
      // payWithTab). Final, loud, do-not-blind-retry.
      openTabs.delete(record.counterparty);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        done: true,
        result: {
          status: 0,
          error:
            `Tab voucher dispatched but the request failed in flight (${msg}). ` +
            `The signed voucher may have reached the seller; do not blind-retry ` +
            `with --no-tab (that can pay twice). Call again — the next call ` +
            `re-reads the on-chain frontier and stays monotonic.`,
          tab: {
            rail: "tab",
            used: false,
            counterparty: record.counterparty,
            cumulativeAtomic: signed.payload.cumulativeAmount,
          },
        },
      };
    }

    if (res.status === 402) {
      // The seller refused the voucher. Roll the counter back (TabImpl
      // internal, duck-typed — same honest-refusal optimization the SDK's
      // own payWithTab uses) and surface the reason table. FINAL: never a
      // silent exact fallback for a refusal.
      const rollback = (tab as Tab & { rollbackVoucher?: (v: SignedVoucher) => boolean })
        .rollbackVoucher;
      rollback?.call(tab, signed);
      openTabs.delete(record.counterparty);

      const body = (await parseBody(res)) as Record<string, unknown> | null;
      const reason = String(body?.reason ?? "unknown");
      const detail = body?.detail != null ? String(body.detail) : undefined;
      return {
        done: true,
        result: {
          status: 402,
          error: explainRefusal(reason, detail, record.sellerUrl),
          tab: {
            rail: "tab",
            used: false,
            refused: true,
            refusalReason: reason,
            ...(detail ? { refusalDetail: detail } : {}),
            counterparty: record.counterparty,
            cumulativeAtomic: signed.payload.cumulativeAmount,
          },
          requirements,
        },
      };
    }

    if (!res.ok) {
      // Voucher accepted the wire but the handler failed (5xx after the
      // middleware, etc). The voucher stands (monotonic counter advanced);
      // report it — the unused budget carries forward to the next voucher.
      const body = await parseBody(res);
      return {
        done: true,
        result: {
          status: res.status,
          error: `Seller returned HTTP ${res.status} after accepting the tab voucher.`,
          data: body,
          tab: {
            rail: "tab",
            used: true,
            counterparty: record.counterparty,
            cumulativeAtomic: signed.payload.cumulativeAmount,
          },
        },
      };
    }

    // ── Accepted: persist the settle receipt + record witnessed spend ──
    updateTab(
      record.counterparty,
      {
        lastVoucherHeader: voucherToHeader(signed),
        lastVoucherAt: new Date().toISOString(),
      },
      dir,
    );
    try {
      budget?.recordSpend(priceUsdc, request.url);
    } catch {
      /* ledger write must never break a paid call */
    }

    const data = await parseBody(res);
    return {
      done: true,
      result: {
        status: res.status,
        data,
        payment: {
          rail: "tab",
          // Honest settlement semantics: value accrued to the open tab —
          // funds move at `opendexter tab close` (or the seller's own
          // crystallization lane). No per-call on-chain transaction exists.
          settled: "accrued_to_tab",
          counterparty: record.counterparty,
          channelId: signed.payload.channelId,
          incrementAtomic: tabAccept.amountAtomic,
          priceUsdc,
          // SESSION-LIFETIME odometer (includes the resumed chain frontier),
          // matching on-chain cumulative semantics — NOT this process's spend.
          cumulativeAtomic: signed.payload.cumulativeAmount,
          sequenceNumber: signed.payload.sequenceNumber,
          close: `opendexter tab close ${record.sellerUrl}`,
        },
      },
    };
  };
}
