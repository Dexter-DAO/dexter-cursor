/**
 * Vault session custody — `~/.dexterai-mcp/vault.json`.
 *
 * Holds the token pair `opendexter connect` receives from the OAuth device
 * grant so `opendexter wallet` can read the user's hosted wallet without
 * re-authenticating every call. The local MCP and paid CLI paths do not read
 * this file. This is a bearer credential (accessToken/refreshToken) — use the
 * same custody discipline as `../tabs/store.ts`'s session-secret file, not the
 * plain writeFileSync used by wallet.json.
 *
 * Storage: 0700 dir, 0600 file, atomic write (temp file + rename) so a torn
 * write (crash / disk-full mid-write) can never leave truncated JSON —
 * loadSession's corrupt-file branch would silently discard it, dropping the
 * session. The read path must NEVER throw: the wallet-view path depends on a
 * missing or corrupt file degrading to "no session", not a crash.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";

export const VAULT_SESSION_FILE_NAME = "vault.json";

export interface VaultSession {
  version: 1;
  accessToken: string;
  refreshToken: string;
  vaultAddress: string;
  vaultPda: string;
  expiresAt: number;
  deviceLabel: string;
}

function fileFor(dir?: string): string {
  return join(dir ?? DATA_DIR, VAULT_SESSION_FILE_NAME);
}

/** Never throws: absent or corrupt file both degrade to "no session". */
export function loadSession(dir?: string): VaultSession | null {
  const file = fileFor(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<VaultSession>;
    if (parsed.version !== 1) return null;
    return parsed as VaultSession;
  } catch {
    // A corrupt session file must not crash the wallet-view path; the CLI simply
    // sees no session and re-prompts `opendexter connect`. (The file only
    // becomes corrupt via external edits — we always write whole-file JSON.)
    return null;
  }
}

export function saveSession(session: VaultSession, dir?: string): void {
  const base = dir ?? DATA_DIR;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const file = fileFor(dir);
  // Atomic write: this file holds bearer tokens. A torn writeFileSync would
  // leave truncated JSON that loadSession's corrupt-file branch silently
  // discards — losing the session. Write a temp file, then rename: rename is
  // atomic on POSIX, so a reader sees either the whole old file or the whole
  // new one, never a half. 0600 is set at temp creation AND re-asserted
  // after (a pre-existing temp could carry looser perms).
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function clearSession(dir?: string): void {
  const file = fileFor(dir);
  try {
    rmSync(file, { force: true });
  } catch {
    /* noop — already gone */
  }
}
