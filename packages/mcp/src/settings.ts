import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR } from "./config.js";
import { join } from "node:path";

export const SETTINGS_FILE = join(DATA_DIR, "settings.json");
export const DEFAULT_MAX_AMOUNT_USDC = 5;

export interface DexterSettings {
  /** Per-call spend cap in USDC — no single paid call may exceed this. */
  maxAmountUsdc: number;
  /**
   * Rolling 24h spend budget in USDC. 0 = disabled (opt-in). When set, the
   * sum of x402 spend made THROUGH THIS TOOL in the trailing 24h may not
   * exceed it — this is the velocity guard a per-call cap cannot provide
   * (it stops a loop of small in-cap calls draining the wallet).
   *
   * Honest scope: this budget can only see spending it witnessed. Payments
   * made by the same wallet through other tools/machines are not counted.
   */
  dailyBudgetUsdc: number;
}

function coercePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}
function coerceNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 0 ? value : fallback;
}

export function loadSettings(): DexterSettings {
  const defaults: DexterSettings = {
    maxAmountUsdc: DEFAULT_MAX_AMOUNT_USDC,
    dailyBudgetUsdc: 0,
  };
  if (!existsSync(SETTINGS_FILE)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Partial<DexterSettings>;
    return {
      maxAmountUsdc: coercePositive(raw.maxAmountUsdc, defaults.maxAmountUsdc),
      dailyBudgetUsdc: coerceNonNegative(raw.dailyBudgetUsdc, defaults.dailyBudgetUsdc),
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(next: Partial<DexterSettings>): DexterSettings {
  const current = loadSettings();
  const merged: DexterSettings = {
    maxAmountUsdc: coercePositive(next.maxAmountUsdc, current.maxAmountUsdc),
    dailyBudgetUsdc:
      next.dailyBudgetUsdc === undefined
        ? current.dailyBudgetUsdc
        : coerceNonNegative(next.dailyBudgetUsdc, current.dailyBudgetUsdc),
  };
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  return merged;
}
