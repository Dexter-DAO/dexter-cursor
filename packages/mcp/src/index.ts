import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { checkStaleness } from "./staleness.js";

async function main() {
  // Startup staleness probe: throttled to once/day and fire-and-forget — never
  // awaited, so it can never delay a command. `background: true` unrefs the
  // socket: the long-lived `server` command stays alive to print the notice on
  // stderr, while a one-shot CLI abandons the probe on exit instead of hanging.
  // Offline/uninstalled config dir → silent.
  void checkStaleness({ throttle: true, context: "startup", background: true }).catch(() => {});

  await yargs(hideBin(process.argv))
    .scriptName("opendexter")
    .usage("$0 [command] [options]")
    .option("dev", {
      type: "boolean",
      description: "Use localhost endpoints instead of production",
      default: false,
    })
    .command(
      ["$0", "server"],
      "Start the MCP server (default)",
      (y) =>
        y.option("transport", {
          choices: ["stdio"] as const,
          default: "stdio" as const,
          description: "Transport mode",
        }),
      async (args) => {
        const { startServer } = await import("./server/index.js");
        await startServer({
          transport: args.transport,
          dev: args.dev,
        });
      },
    )
    .command(
      "install",
      "Install Dexter MCP into an AI client (Cursor, Claude, Codex, etc.)",
      (y) =>
        y
          .option("client", {
            type: "string",
            description: "Client to install into",
          })
          .option("yes", {
            alias: "y",
            type: "boolean",
            description: "Skip prompts",
            default: false,
          })
          .option("all", {
            type: "boolean",
            description: "Install into all auto-detected supported clients",
            default: false,
          }),
      async (args) => {
        const { runInstall } = await import("./cli/install/index.js");
        await runInstall({ client: args.client, yes: args.yes, all: args.all, dev: args.dev });
      },
    )
    .command(
      "setup",
      "Set up wallet, install into detected clients, and show the fastest path to first use",
      (y) =>
        y.option("yes", {
          alias: "y",
          type: "boolean",
          description: "Skip prompts where possible",
          default: false,
        }),
      async (args) => {
        const { runSetup } = await import("./cli/onboard.js");
        await runSetup({ yes: args.yes, dev: args.dev });
      },
    )
    .command(
      "access <url>",
      "Access an identity-gated endpoint using wallet proof instead of payment",
      (y) =>
        y
          .positional("url", { type: "string", demandOption: true })
          .option("method", {
            choices: ["GET", "POST", "PUT", "DELETE"] as const,
            default: "GET" as const,
          })
          .option("body", { type: "string", description: "JSON request body" })
          .option("network", { type: "string", description: "Optional preferred auth network" }),
      async (args) => {
        const { cliAccess } = await import("./tools/access.js");
        await cliAccess(args.url!, {
          method: args.method,
          body: args.body,
          network: args.network,
          dev: args.dev,
        });
      },
    )
    .command(
      "check <url>",
      "Inspect an endpoint's x402 pricing and requirements without paying",
      (y) =>
        y
          .positional("url", { type: "string", demandOption: true })
          .option("method", {
            choices: ["GET", "POST", "PUT", "DELETE"] as const,
            default: "GET" as const,
          }),
      async (args) => {
        const { cliCheck } = await import("./tools/check.js");
        await cliCheck(args.url!, {
          method: args.method,
          dev: args.dev,
        });
      },
    )
    .command(
      "audition <url>",
      "Audition an x402 API for the OpenDexter catalog — real paid test, quality score, synthesized agent Skill",
      (y) =>
        y
          .positional("url", { type: "string", demandOption: true })
          .option("json", {
            type: "boolean",
            default: false,
            description: "Machine-readable output (for agents driving the audition)",
          }),
      async (args) => {
        const { cliAudition } = await import("./tools/audition.js");
        await cliAudition(args.url!, {
          json: args.json,
          dev: args.dev,
        });
      },
    )
    .command(
      "settings",
      "Read or update OpenDexter spending policy",
      (y) =>
        y
          .option("max-amount", {
            type: "number",
            description: "Per-call spend cap (USDC) — no single call may exceed it",
          })
          .option("daily-budget", {
            type: "number",
            description:
              "Rolling 24h spend budget (USDC) — the velocity guard. 0 disables it.",
          }),
      async (args) => {
        const { cliSettings } = await import("./tools/settings.js");
        await cliSettings({
          maxAmountUsdc: args["max-amount"],
          dailyBudgetUsdc: args["daily-budget"],
        });
      },
    )
    .command(
      "wallet",
      "Show wallet address and balances",
      (y) =>
        y
          .option("vanity", {
            type: "boolean",
            description: "Generate a vanity wallet address",
            default: false,
          })
          .option("solana-prefix", {
            type: "string",
            description: "Desired Solana prefix (example: Dex)",
          })
          .option("evm-prefix", {
            type: "string",
            description: "Desired EVM prefix after 0x (example: 402dd)",
          })
          .option("case-sensitive", {
            type: "boolean",
            description: "Treat vanity prefixes as case-sensitive",
            default: false,
          })
          .option("yes", {
            alias: "y",
            type: "boolean",
            description: "Skip prompts where possible",
            default: false,
          }),
      async (args) => {
        if (args.vanity) {
          const { runVanityFlow } = await import("./wallet/vanity-flow.js");
          await runVanityFlow({
            dev: args.dev,
            solanaPrefix: args["solana-prefix"],
            evmPrefix: args["evm-prefix"],
            caseSensitive: args["case-sensitive"],
            yes: args.yes,
          });
          return;
        }

        const { showWalletInfo } = await import("./wallet/index.js");
        await showWalletInfo({ dev: args.dev });
      },
    )
    .command(
      "search <query>",
      "Search the Dexter x402 marketplace",
      (y) =>
        y.positional("query", { type: "string", demandOption: true }),
      async (args) => {
        const { cliSearch } = await import("./tools/search.js");
        await cliSearch(args.query!, { dev: args.dev });
      },
    )
    .command(
      "fetch <url>",
      "Fetch an x402-protected resource with automatic payment (tab-first when a tab is open with the seller)",
      (y) =>
        y
          .positional("url", { type: "string", demandOption: true })
          .option("method", {
            choices: ["GET", "POST", "PUT", "DELETE"] as const,
            default: "GET" as const,
          })
          .option("max-amount", {
            type: "number",
            description: "Optional per-call spend cap override in USDC",
          })
          .option("body", { type: "string", description: "JSON request body" })
          .option("tab", {
            type: "boolean",
            default: true,
            description:
              "Pay via an open tab when the seller offers one (--no-tab forces exact)",
          }),
      async (args) => {
        const { cliFetch } = await import("./tools/fetch.js");
        await cliFetch(args.url!, {
          method: args.method,
          body: args.body,
          maxAmountUsdc: args["max-amount"],
          noTab: args.tab === false,
          dev: args.dev,
        });
      },
    )
    .command(
      "tab <subcommand> [target]",
      "Open, inspect, settle, or remove spend-tabs with x402 sellers",
      (y) =>
        y
          .positional("subcommand", {
            type: "string",
            choices: ["connect", "list", "close", "remove"] as const,
            demandOption: true,
          })
          .positional("target", {
            type: "string",
            description: "Seller URL (connect/close/remove) or counterparty pubkey (close/remove)",
          })
          .option("wait", {
            type: "boolean",
            default: true,
            description:
              "connect: poll the chain for the passkey approval (--no-wait prints the link and exits)",
          })
          .option("timeout", {
            type: "number",
            default: 10,
            description: "connect: minutes to poll for the passkey approval",
          })
          .option("rekey", {
            type: "boolean",
            default: false,
            description:
              "connect: force a fresh session key over an existing tab (recovery for cumulative_exceeds_cap)",
          }),
      async (args) => {
        switch (args.subcommand) {
          case "connect": {
            if (!args.target) throw new Error("tab connect requires a seller URL");
            const { cliTabConnect } = await import("./tabs/connect.js");
            await cliTabConnect(args.target, {
              wait: args.wait,
              timeoutMs: args.timeout * 60 * 1000,
              rekey: args.rekey,
              dev: args.dev,
            });
            break;
          }
          case "list": {
            const { cliTabList } = await import("./tabs/cli.js");
            await cliTabList();
            break;
          }
          case "close": {
            if (!args.target) throw new Error("tab close requires a seller URL or counterparty");
            const { cliTabClose } = await import("./tabs/cli.js");
            await cliTabClose(args.target);
            break;
          }
          case "remove": {
            if (!args.target) throw new Error("tab remove requires a seller URL or counterparty");
            const { cliTabRemove } = await import("./tabs/cli.js");
            await cliTabRemove(args.target);
            break;
          }
        }
      },
    )
    .command(
      "dextercard <subcommand>",
      "Manage your Dextercard session (login, logout, status, refresh)",
      (y) =>
        y
          .positional("subcommand", {
            type: "string",
            choices: ["login", "logout", "status", "refresh"] as const,
            demandOption: true,
          })
          .option("email", {
            type: "string",
            description: "Email to receive the OTP (login only)",
          })
          .option("yes", {
            alias: "y",
            type: "boolean",
            default: false,
            description: "Skip confirmation prompts (logout only)",
          }),
      async (args) => {
        const mod = await import("./cli/dextercard.js");
        switch (args.subcommand) {
          case "login":
            await mod.cliDextercardLogin({ email: args.email });
            break;
          case "logout":
            await mod.cliDextercardLogout({ yes: args.yes });
            break;
          case "status":
            await mod.cliDextercardStatus();
            break;
          case "refresh":
            await mod.cliDextercardRefresh();
            break;
        }
      },
    )
    .command(
      "pay <url>",
      "Alias of fetch for clients that want an explicit payment verb",
      (y) =>
        y
          .positional("url", { type: "string", demandOption: true })
          .option("method", {
            choices: ["GET", "POST", "PUT", "DELETE"] as const,
            default: "GET" as const,
          })
          .option("max-amount", {
            type: "number",
            description: "Optional per-call spend cap override in USDC",
          })
          .option("body", { type: "string", description: "JSON request body" })
          .option("tab", {
            type: "boolean",
            default: true,
            description:
              "Pay via an open tab when the seller offers one (--no-tab forces exact)",
          }),
      async (args) => {
        const { cliFetch } = await import("./tools/fetch.js");
        await cliFetch(args.url!, {
          method: args.method,
          body: args.body,
          maxAmountUsdc: args["max-amount"],
          noTab: args.tab === false,
          dev: args.dev,
        });
      },
    )
    .strict()
    .help()
    // Throw parse failures (unknown command/argument) instead of letting yargs
    // exit for us, so main().catch can add the staleness notice before exit.
    .fail(false)
    .parseAsync();
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  // An unknown command/argument is the exact signal a stale global install
  // gives off (it lacks a command this build ships). Force the staleness probe
  // — bypassing the daily throttle — so the upgrade line lands on the very
  // invocation that failed.
  if (/Unknown (command|argument)/i.test(message)) {
    process.stderr.write(message + "\n");
    process.stderr.write("Run `opendexter --help` for the current command list.\n");
    await checkStaleness({ throttle: false, context: "unknown-command" }).catch(() => {});
  } else {
    console.error(err);
  }
  process.exit(1);
});
