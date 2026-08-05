import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { checkStaleness } from "./staleness.js";

const cliArgs = hideBin(process.argv);
const invokedCommand = cliArgs.find((argument) => !argument.startsWith("-"));
const doctorInvocation = invokedCommand === "doctor";

async function main() {
  // Startup staleness probe: throttled to once/day and fire-and-forget — never
  // awaited, so it can never delay a command. `background: true` unrefs the
  // socket: the long-lived `server` command stays alive to print the notice on
  // stderr, while a one-shot CLI abandons the probe on exit instead of hanging.
  // Offline/uninstalled config dir → silent.
  if (!doctorInvocation) {
    void checkStaleness({ throttle: true, context: "startup", background: true }).catch(() => {});
  }

  await yargs(cliArgs)
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
      "Register the local OpenDexter MCP in an AI client without paying",
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
          })
          .option("registration-name", {
            type: "string",
            default: "opendexter",
            description:
              "Name for the one OpenDexter MCP registration. An alias cannot bypass an existing OpenDexter registration.",
          }),
      async (args) => {
        const { runInstall } = await import("./cli/install/index.js");
        const result = await runInstall({
          client: args.client,
          yes: args.yes,
          all: args.all,
          registrationName: args["registration-name"],
          dev: args.dev,
        });
        if (!result.complete) process.exitCode = 1;
      },
    )
    .command(
      "doctor",
      "Read-only install, registration, and payment-readiness diagnosis",
      (y) =>
        y
          .option("client", {
            type: "string",
            description: "Inspect one client instead of all detected clients",
          })
          .option("registration-name", {
            type: "string",
            default: "opendexter",
            description: "MCP registration name to inspect",
          })
          .option("json", {
            type: "boolean",
            default: false,
            description: "Print the read-only report as JSON",
          }),
      async (args) => {
        const { runDoctor } = await import("./cli/doctor.js");
        await runDoctor({
          client: args.client,
          registrationName: args["registration-name"],
          json: args.json,
        });
      },
    )
    .command(
      "setup",
      "Install into detected clients and show the hosted connection path",
      (y) =>
        y
          .option("yes", {
            alias: "y",
            type: "boolean",
            description: "Skip prompts where possible",
            default: false,
          })
          .option("registration-name", {
            type: "string",
            default: "opendexter",
            description:
              "Name for the one OpenDexter MCP registration. An alias cannot bypass an existing OpenDexter registration.",
          }),
      async (args) => {
        const { runInstall } = await import("./cli/install/index.js");
        const result = await runInstall({
          yes: args.yes,
          all: true,
          dev: args.dev,
          registrationName: args["registration-name"],
        });
        if (result.complete) {
          console.log(
            "OpenDexter installed. Run `opendexter connect` to approve the hosted governed x402 runtime; local wallet.json/env signers are not payment executors.",
          );
        }
        if (!result.complete) process.exitCode = 1;
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
          })
          .option("body", {
            type: "string",
            description:
              "Exact JSON object to price for POST/PUT/DELETE. Required for an execution-bound prepared purchase.",
          }),
      async (args) => {
        const { cliCheck } = await import("./tools/check.js");
        await cliCheck(args.url!, {
          method: args.method,
          body: args.body,
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
      "Show hosted wallet authority, or explicitly inspect a legacy wallet read-only",
      (y) =>
        y
          .option("legacy-recovery", {
            type: "boolean",
            description:
              "Read public addresses and balances from an existing wallet.json without loading or enabling its signer",
            default: false,
          }),
      async (args) => {
        const { showWalletInfo } = await import("./wallet/index.js");
        await showWalletInfo({
          dev: args.dev,
          legacyRecovery: args["legacy-recovery"],
        });
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
      "fetch",
      "Execute one connected hosted governed intent",
      (y) =>
        y
          .option("max-amount-atomic", {
            type: "string",
            description: "User-approved atomic ceiling; required for every hosted intent",
          })
          .option("intent-id", {
            type: "string",
            description: "Opaque intentId returned by connected `opendexter check`",
          }),
      async (args) => {
        const { cliFetch } = await import("./tools/fetch.js");
        await cliFetch({
          maxAmountAtomic: args["max-amount-atomic"],
          intentId: args["intent-id"],
          dev: args.dev,
        });
      },
    )
    .command(
      "connect [subcommand]",
      "Connect this CLI to the hosted governed x402 runtime, or check/clear the connection",
      (y) =>
        y
          .positional("subcommand", {
            type: "string",
            choices: ["status", "disconnect"] as const,
            description:
              "Omit to connect; `status` reads live governed authority; `disconnect` clears it",
          })
          .option("browser", {
            type: "boolean",
            default: true,
            description:
              "Offer to open the approval link in a browser (--no-browser prints link + QR + code only, for headless machines)",
          }),
      async (args) => {
        const mod = await import("./connect/connect.js");
        switch (args.subcommand) {
          case "status":
            await mod.cliConnectStatus({ dev: args.dev });
            break;
          case "disconnect":
            await mod.cliConnectDisconnect();
            break;
          default:
            await mod.cliConnect({ dev: args.dev, noBrowser: args.browser === false });
            break;
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
      "pay",
      "Alias of fetch for one connected hosted governed intent",
      (y) =>
        y
          .option("max-amount-atomic", {
            type: "string",
            description: "User-approved atomic ceiling; required for every hosted intent",
          })
          .option("intent-id", {
            type: "string",
            description: "Opaque intentId returned by connected `opendexter check`",
          }),
      async (args) => {
        const { cliFetch } = await import("./tools/fetch.js");
        await cliFetch({
          maxAmountAtomic: args["max-amount-atomic"],
          intentId: args["intent-id"],
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
    if (!doctorInvocation) {
      await checkStaleness({ throttle: false, context: "unknown-command" }).catch(() => {});
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
