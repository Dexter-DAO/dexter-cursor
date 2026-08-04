import { loadOrCreateWallet, getAllBalances } from "../wallet/index.js";
import { runInstall } from "./install/index.js";
import { CLIENTS, detectInstalledClients } from "./install/clients.js";
import { intro, outro, log, note } from "@clack/prompts";
import chalk from "chalk";
import { SUPPORTED_CHAIN_LABELS, VERSION } from "../config.js";

interface SetupOpts {
  dev: boolean;
  yes: boolean;
  registrationName?: string;
}

export interface SetupResult {
  complete: boolean;
}

function fundingAdvice(totalUsdc: number, wallet: { solanaAddress?: string; evmAddress?: string }) {
  if (totalUsdc > 0) {
    return [
      `Treasury online with ${totalUsdc.toFixed(2)} USDC available across active rails.`,
      "Search and check remain read-only. A paid call still needs one exact prepared purchase and ceiling authorized by the user's instruction or delegated policy.",
    ];
  }

  const lines = ["Treasury created, but no USDC is loaded yet."];
  if (wallet.solanaAddress) {
    lines.push(`- Solana funding rail: ${wallet.solanaAddress}`);
  }
  if (wallet.evmAddress) {
    lines.push(`- EVM funding rail:    ${wallet.evmAddress}`);
  }
  lines.push("Search and check work now without funding.");
  lines.push(
    "Fund only before the user's instruction or delegated policy authorizes a paid settlement.",
  );
  return lines;
}

export async function runSetup(opts: SetupOpts): Promise<SetupResult> {
  const cli = `npx @dexterai/opendexter@${VERSION}`;

  intro(chalk.bold("OpenDexter setup"));
  log.message(
    "Checking client registrations first, then preparing optional local payment authority.",
  );

  const detected = detectInstalledClients();
  if (detected.length > 0) {
    const install = await runInstall({
      dev: opts.dev,
      yes: opts.yes,
      all: true,
      registrationName: opts.registrationName,
      skipWalletSetup: true,
    });
    if (!install.complete) {
      outro(
        "OpenDexter left colliding or uncertain client registrations unchanged. Keep one OpenDexter registration, or remove the existing one intentionally before rerunning setup; no wallet was created by this setup run.",
      );
      return { complete: false };
    }
  } else {
    log.warn("No supported clients were auto-detected.");
    log.message("You can still run `opendexter install --client <name>` manually later.");
  }

  const wallet = await loadOrCreateWallet({ quiet: true });
  if (!wallet) {
    console.error("Failed to create or load wallet.");
    process.exit(1);
  }

  const walletStatus =
    wallet.status === "created"
      ? "Fresh wallet activated"
      : wallet.status === "migrated"
        ? "Wallet upgraded for multichain settlement"
        : wallet.status === "env"
          ? "Wallet loaded from environment"
          : "Wallet online";
  log.step(walletStatus);
  if (wallet.info.solanaAddress) log.info(`Solana rail: ${wallet.info.solanaAddress}`);
  if (wallet.info.evmAddress) log.info(`EVM rail:    ${wallet.info.evmAddress}`);

  const { totalUsdc } = await getAllBalances(wallet.info);

  note(`Settlement live across: ${SUPPORTED_CHAIN_LABELS.join(" · ")}`, "Rails");

  note(fundingAdvice(totalUsdc, wallet.info).join("\n"), "Funding");

  note(
    [
      `1. Run \`${cli} search <what-you-need>\` now; search needs no funding.`,
      `2. Run \`${cli} check <url>\` to read live terms without paying.`,
      `3. Before a paid call, run \`${cli} wallet\` and fund the chosen rail if needed.`,
      `4. After the user's instruction or delegated policy authorizes it, pass the unchanged prepared purchase and exact atomic ceiling to \`${cli} fetch <url>\`.`,
    ].join("\n"),
    "First-use path",
  );

  let nextMove = "";
  if (totalUsdc > 0) {
    nextMove = "Treasury funded. Start with a real marketplace search for the task you actually want to complete.";
  } else {
    nextMove = `Start with \`${cli} search <what-you-need>\` now. Fund a rail only when the user's instruction or delegated policy authorizes a paid call.`;
  }
  outro(nextMove);

  return { complete: true };
}
