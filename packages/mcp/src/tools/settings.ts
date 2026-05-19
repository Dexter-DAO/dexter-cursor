import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadSettings, saveSettings, SETTINGS_FILE } from "../settings.js";
import { spentLast24h } from "../spend-ledger.js";

/**
 * Builds the x402_settings response. Reports both spend controls and — for
 * the budget — how much has been spent so far, so the agent can reason about
 * headroom. The `tip` text is deliberately honest about each control's scope:
 * the budget only sees spend made through this tool, never the wallet's
 * total on-chain spend.
 */
function buildPayload(settings: ReturnType<typeof loadSettings>) {
  const spent = spentLast24h();
  return {
    settings,
    spend: {
      last24hUsdc: Number(spent.toFixed(6)),
      budgetRemainingUsdc:
        settings.dailyBudgetUsdc > 0
          ? Number(Math.max(0, settings.dailyBudgetUsdc - spent).toFixed(6))
          : null,
    },
    settingsFile: SETTINGS_FILE,
    tips: [
      "maxAmountUsdc — per-call cap: x402_fetch refuses any single call priced above it.",
      settings.dailyBudgetUsdc > 0
        ? "dailyBudgetUsdc — rolling 24h budget: x402_fetch refuses a call that would push spend-through-this-tool over it. Set to 0 to disable."
        : "dailyBudgetUsdc is 0 (disabled). Set it to add a rolling 24h spend ceiling — the guard against a loop of small in-cap calls.",
      "Scope note: the budget counts only x402 spend made through this tool on this machine — not the wallet's total on-chain spend.",
    ],
  };
}

export function registerSettingsTool(server: McpServer): void {
  server.tool(
    "x402_settings",
    "Read or update OpenDexter spending policy: maxAmountUsdc (per-call cap) " +
      "and dailyBudgetUsdc (rolling 24h budget — the velocity guard). Also " +
      "reports spend in the trailing 24h.",
    {
      maxAmountUsdc: z
        .number()
        .positive()
        .optional()
        .describe("New per-call spend cap in USDC."),
      dailyBudgetUsdc: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "New rolling 24h spend budget in USDC. 0 disables the budget.",
        ),
    },
    async (args) => {
      const hasUpdate =
        args.maxAmountUsdc != null || args.dailyBudgetUsdc != null;
      const settings = hasUpdate
        ? saveSettings({
            maxAmountUsdc: args.maxAmountUsdc,
            dailyBudgetUsdc: args.dailyBudgetUsdc,
          })
        : loadSettings();

      const payload = buildPayload(settings);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      } as any;
    },
  );
}

export async function cliSettings(opts: {
  maxAmountUsdc?: number;
  dailyBudgetUsdc?: number;
}): Promise<void> {
  const hasUpdate = opts.maxAmountUsdc != null || opts.dailyBudgetUsdc != null;
  const settings = hasUpdate
    ? saveSettings({
        maxAmountUsdc: opts.maxAmountUsdc,
        dailyBudgetUsdc: opts.dailyBudgetUsdc,
      })
    : loadSettings();

  console.log(JSON.stringify(buildPayload(settings), null, 2));
}
