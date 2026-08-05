import { loadSettings, saveSettings, SETTINGS_FILE } from "../settings.js";
import { spentLast24h } from "../spend-ledger.js";

/** Builds a truthful compatibility view of the retired local policy record. */
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
    hostedAuthorityAffected: false,
    paymentEnabled: false,
    manageUrl: "https://dexter.cash/wallet",
    tips: [
      "This is a legacy local record. The hosted governed runtime does not read it.",
      "Manage the real grant, per-call and aggregate limits, and revocation at https://dexter.cash/wallet.",
      "Run `opendexter connect status` to read the live bearer-authenticated authority projection.",
    ],
  };
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
