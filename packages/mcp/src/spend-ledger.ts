import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * The spend ledger — an append-only record of x402 payments this tool has
 * witnessed. It exists to power the rolling 24h budget (see settings.ts):
 * a per-call cap cannot stop a loop of small in-cap calls draining a wallet;
 * the budget can, by summing recent witnessed spend.
 *
 * HONEST SCOPE: the ledger only records payments made THROUGH THIS TOOL on
 * THIS MACHINE. Payments by the same wallet via other tools, other machines,
 * or the hosted server are not visible here. Any user-facing copy must say
 * "spend through this tool", never "your wallet's daily spend".
 *
 * Format: newline-delimited JSON, one record per successful paid call.
 *   {"ts": <epoch ms>, "usdc": <number>, "url": <string>}
 * Append-only — never rewritten — so a crash mid-call cannot corrupt history.
 */

export const SPEND_LEDGER_FILE = join(DATA_DIR, "spend-ledger.jsonl");

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SpendRecord {
  ts: number;
  usdc: number;
  url: string;
}

/** Record a successful paid call. Never throws — a ledger write failing must
 *  not break a payment that already settled. */
export function recordSpend(usdc: number, url: string): void {
  if (!Number.isFinite(usdc) || usdc <= 0) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const record: SpendRecord = { ts: Date.now(), usdc, url };
    appendFileSync(SPEND_LEDGER_FILE, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch {
    /* ledger write failed — non-fatal; the payment itself is unaffected */
  }
}

/** Sum of witnessed x402 spend in the trailing 24h, in USDC. */
export function spentLast24h(now: number = Date.now()): number {
  if (!existsSync(SPEND_LEDGER_FILE)) return 0;
  let total = 0;
  try {
    const lines = readFileSync(SPEND_LEDGER_FILE, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as Partial<SpendRecord>;
        if (
          typeof rec.ts === "number" &&
          typeof rec.usdc === "number" &&
          rec.usdc > 0 &&
          now - rec.ts <= WINDOW_MS
        ) {
          total += rec.usdc;
        }
      } catch {
        /* skip a corrupt line — never let one bad record break the sum */
      }
    }
  } catch {
    return 0;
  }
  return total;
}
