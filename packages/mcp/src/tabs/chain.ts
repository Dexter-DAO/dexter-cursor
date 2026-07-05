/**
 * Chain-side discovery for the consent handoff.
 *
 * The /tabs/connect deep link carries NO callback (verified against the fe
 * source: ConnectTab.tsx builds its requestSpendGrant blob without a
 * `callback` field, so OpenTabConsent never redirects or POSTs anywhere).
 * The human may also approve on a DIFFERENT DEVICE than the one running the
 * CLI, so a localhost callback could never be the contract anyway.
 *
 * The poll target is the chain itself: the approval's sponsor lands a
 * `register_session_key` tx that writes a 162-byte SessionAccount PDA
 * carrying our session pubkey, the counterparty, the user's vault, AND every
 * consented scope field (cap / expiry / nonce / revolving capacity). One
 * getProgramAccounts with memcmp filters finds it without knowing the vault
 * in advance — and because `tabFromGrant`'s params-drift guard compares
 * params against this same account, reading the params FROM the chain
 * guarantees they can never disagree with it.
 *
 * Memcmp offsets come from the canonical @dexterai/vault SessionAccount
 * layout (dist/session decode contract, verified against the deployed
 * program):
 *   8  discriminator | 8 version u8 | 9 bump | 10 vault | 42 session_pubkey
 *   74 max_amount | 82 expires_at | 90 allowed_counterparty | 122 nonce
 *   126 spent | 134 current_outstanding | 142 max_revolving_capacity
 *   150 crystallized_cumulative | 158 last_locked_sequence  (= 162)
 * The decode itself is delegated to the vault SDK's decodeSessionAccount —
 * the offsets here are only used to FILTER; a layout drift would surface as
 * a decode mismatch in tests, not silent misreads.
 */

import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeSessionAccount, isSessionLive } from "@dexterai/vault/session";
import { SESSION_ACCOUNT_SIZE } from "@dexterai/vault/constants";
import { DEXTER_VAULT_PROGRAM_ID } from "@dexterai/x402/tab";
import type { TabGrantParams } from "./store.js";

const SESSION_PUBKEY_OFFSET = 42;
const COUNTERPARTY_OFFSET = 90;

export interface FoundSession {
  sessionPda: string;
  vaultPda: string;
  version: number;
  /** version === 1 AND unexpired (vault SDK's isSessionLive). */
  live: boolean;
  /** The consented scope as the chain enforces it. */
  params: TabGrantParams;
  spentAtomic: string;
  crystallizedAtomic: string;
}

/**
 * Find the SessionAccount registered for (sessionPubkey, counterparty).
 * Returns null while the human has not approved yet — the poll's waiting
 * state. The session pubkey is a fresh keypair minted by this CLI, so a
 * match is OURS by construction.
 */
export async function findSessionByAgentKey(
  connection: Connection,
  sessionPubkey: string,
  counterparty: string,
): Promise<FoundSession | null> {
  const accounts = await connection.getProgramAccounts(DEXTER_VAULT_PROGRAM_ID, {
    filters: [
      { dataSize: SESSION_ACCOUNT_SIZE },
      { memcmp: { offset: SESSION_PUBKEY_OFFSET, bytes: sessionPubkey } },
      { memcmp: { offset: COUNTERPARTY_OFFSET, bytes: counterparty } },
    ],
  });
  if (accounts.length === 0) return null;

  // (vault, counterparty) is unique per session PDA and the session pubkey
  // is fresh entropy — more than one match would mean the same agent key was
  // granted from two different vaults. Take the first live one, else the first.
  const decoded = accounts.map((a) =>
    decodeSessionAccount(a.pubkey, a.account.data as Buffer),
  );
  const state = decoded.find((s) => isSessionLive(s)) ?? decoded[0];

  return {
    sessionPda: state.address,
    vaultPda: state.vault,
    version: state.version,
    live: isSessionLive(state),
    params: {
      maxAmountAtomic: state.session.maxAmount.toString(),
      expiresAtUnix: Number(state.session.expiresAt),
      nonce: state.session.nonce,
      maxRevolvingCapacityAtomic: state.session.maxRevolvingCapacity.toString(),
    },
    spentAtomic: state.session.spent.toString(),
    crystallizedAtomic: state.session.crystallizedCumulative.toString(),
  };
}

/** Read the live frontier for an ACTIVE record (status displays). */
export async function readSessionFrontier(
  connection: Connection,
  vaultPda: string,
  counterparty: string,
): Promise<{ live: boolean; spentAtomic: string; crystallizedAtomic: string } | null> {
  const { fetchSessionAccount } = await import("@dexterai/vault/session");
  const state = await fetchSessionAccount(
    connection,
    new PublicKey(vaultPda),
    new PublicKey(counterparty),
  );
  if (!state) return null;
  return {
    live: isSessionLive(state),
    spentAtomic: state.session.spent.toString(),
    crystallizedAtomic: state.session.crystallizedCumulative.toString(),
  };
}
