/**
 * `opendexter dextercard ...` CLI commands.
 *
 * Drives the LoginFlow against the live carrier so users can provision
 * a Dextercard session (`login`), tear it down (`logout`), or inspect
 * what's stored (`status`). All three commands operate on the same
 * EncryptedFileSessionStore that the npm CLI's CardsAdapter resumes
 * from at server startup, so a successful `login` immediately enables
 * the four card_* MCP tools on the next server restart.
 *
 * Captcha collection is not built into this CLI today. The carrier's
 * /api/tools/login endpoint requires an hCaptcha token; users solve it
 * by visiting agents.moonpay.com/login in a browser and reading the
 * OTP from their email. That UX is intentional — we keep the CLI thin
 * and source the captcha from the carrier's first-party widget rather
 * than embedding our own.
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import { refresh, verify } from "@dexterai/dextercard";
import { createNpmCardsAdapter } from "../cards-adapter.js";
import { tryOpenInBrowser } from "../util/browser.js";

export async function cliDextercardLogin(opts: { email?: string }): Promise<void> {
  const adapter = createNpmCardsAdapter();
  const state = adapter.state();

  if (state.hasSession) {
    p.log.warn(
      `An existing Dextercard session is stored at ${state.sessionPath}. Run \`opendexter dextercard logout\` first if you want to swap accounts.`,
    );
    return;
  }

  p.intro(chalk.bold("Provision a Dextercard session"));

  const email =
    opts.email ||
    (await p.text({
      message: "Email to receive the one-time code",
      placeholder: "you@example.com",
      validate: (v) => (v && v.includes("@") ? undefined : "Email required"),
    }));
  if (typeof email !== "string") return;

  const loginUrl = `https://agents.moonpay.com/login?email=${encodeURIComponent(email)}`;
  const opened = tryOpenInBrowser(loginUrl);

  p.note(
    [
      opened
        ? "Opened the carrier login page in your browser."
        : "Open this URL in your browser:",
      "",
      `   ${loginUrl}`,
      "",
      "Solve the captcha, click Continue, then paste the code from your email below.",
    ].join("\n"),
    "Email + captcha"
  );

  const code = await p.text({
    message: "One-time code from email",
    validate: (v) =>
      v && /^\d{4,8}$/.test(v.trim()) ? undefined : "Expected 4-8 digit code",
  });
  if (typeof code !== "string") return;

  const spinner = p.spinner();
  spinner.start("Exchanging code for session…");

  try {
    const tokens = await verify({ email: email.trim(), code: code.trim() });
    adapter.saveSession(tokens);
    spinner.stop("Session saved.");
  } catch (err: any) {
    spinner.stop("Verification failed.");
    p.cancel(err?.message || String(err));
    process.exitCode = 1;
    return;
  }

  // Best-effort: confirm by hitting userRetrieve through the resume path.
  const probe = p.spinner();
  probe.start("Confirming session…");
  const client = await adapter.getOperations();
  if (!client) {
    probe.stop("Session resume failed (refresh token may already be invalid).");
    p.cancel("Run `opendexter dextercard login` again.");
    process.exitCode = 1;
    return;
  }
  try {
    const user = await client.userRetrieve();
    probe.stop(`Logged in as ${user.email}`);
    p.outro(
      `Dextercard ready. The card_* MCP tools will use this session on the next server restart.`,
    );
  } catch (err: any) {
    probe.stop("Verification call failed.");
    p.cancel(err?.message || String(err));
    process.exitCode = 1;
  }
}

export async function cliDextercardLogout(opts: { yes?: boolean } = {}): Promise<void> {
  const adapter = createNpmCardsAdapter();
  const state = adapter.state();
  if (!state.hasSession) {
    console.log("No Dextercard session stored.");
    return;
  }
  if (!opts.yes) {
    const confirm = await p.confirm({
      message: `Delete Dextercard session at ${state.sessionPath}?`,
      initialValue: false,
    });
    if (confirm !== true) {
      console.log("Aborted.");
      return;
    }
  }
  adapter.clear();
  console.log(`Cleared Dextercard session at ${state.sessionPath}.`);
}

export async function cliDextercardStatus(): Promise<void> {
  const adapter = createNpmCardsAdapter();
  const state = adapter.state();
  console.log(JSON.stringify({ hasSession: state.hasSession, path: state.sessionPath }, null, 2));
  if (!state.hasSession) return;

  const client = await adapter.getOperations();
  if (!client) {
    console.log(JSON.stringify({ resumable: false }, null, 2));
    return;
  }
  try {
    const user = await client.userRetrieve();
    console.log(JSON.stringify({ resumable: true, user }, null, 2));
  } catch (err: any) {
    console.log(JSON.stringify({ resumable: false, error: err?.message }, null, 2));
  }
}

/**
 * `opendexter dextercard refresh` — force the rotation of a stored
 * refresh token, useful if the user is debugging session lifecycle.
 */
export async function cliDextercardRefresh(): Promise<void> {
  const adapter = createNpmCardsAdapter();
  const store = adapter.getStore();
  const stored = store.load();
  if (!stored) {
    console.log("No session to refresh.");
    process.exitCode = 1;
    return;
  }
  try {
    const next = await refresh({ refreshToken: stored.refreshToken });
    store.save(next);
    console.log("Session refreshed. New JWT length:", next.accessToken.length);
  } catch (err: any) {
    console.error("Refresh failed:", err?.message || String(err));
    process.exitCode = 1;
  }
}
