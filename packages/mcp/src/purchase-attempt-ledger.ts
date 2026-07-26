import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  PreparedPurchaseV1,
  PurchaseAttemptClaimV1,
  PurchaseAttemptStateV1,
  PurchaseAttemptStoreV1,
  PurchaseReceiptV1,
  ValidatedPurchaseV1,
} from "@dexterai/x402-mcp-tools";
import { DATA_DIR } from "./config.js";

const STORE_VERSION = "opendexter.purchase-attempt.v1";
const STORE_DIR_NAME = "purchase-attempts-v1";
const UNTOUCHED_PREPARATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const MAX_PRUNE_SCAN = 256;
const MAX_PRUNE_DELETE = 32;

type StoredAttemptState = PurchaseAttemptStateV1 | "prepared";

type StoredAttempt = {
  version: typeof STORE_VERSION;
  preparedId: string;
  preparedFingerprint: string;
  executionFingerprint: string | null;
  state: StoredAttemptState;
  updatedAt: string;
  receipt: PurchaseReceiptV1 | null;
};

export interface DurablePurchaseAttemptStoreV1
  extends PurchaseAttemptStoreV1 {
  prepare(purchase: PreparedPurchaseV1): void;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function preparedFingerprint(
  purchase: PreparedPurchaseV1 | ValidatedPurchaseV1,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        contractVersion: purchase.contractVersion,
        preparedId: purchase.preparedId,
        mode: purchase.mode,
        route: purchase.route,
      }),
    )
    .digest("hex");
}

function executionFingerprint(purchase: ValidatedPurchaseV1): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        preparedFingerprint: preparedFingerprint(purchase),
        approvedAmountCeilingAtomic: purchase.approvedAmountCeilingAtomic,
      }),
    )
    .digest("hex");
}

function recordName(preparedId: string): string {
  return createHash("sha256").update(preparedId).digest("hex");
}

function readAttempt(path: string): StoredAttempt | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAttempt>;
    if (
      value.version !== STORE_VERSION
      || typeof value.preparedId !== "string"
      || typeof value.preparedFingerprint !== "string"
      || (
        value.executionFingerprint !== null
        && typeof value.executionFingerprint !== "string"
      )
      || typeof value.updatedAt !== "string"
      || ![
        "prepared",
        "claimed",
        "awaiting_action",
        "failed_pre_dispatch",
        "dispatching",
        "reconciliation_required",
        "completed",
      ].includes(String(value.state))
    ) {
      return null;
    }
    return value as StoredAttempt;
  } catch {
    return null;
  }
}

function writeAttempt(path: string, attempt: StoredAttempt): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(attempt)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temp, path);
}

function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A missing lock is already released. Any other failure leaves the
    // attempt fail-closed because a subsequent begin cannot claim it.
  }
}

/**
 * One durable file plus an O_EXCL lock per prepared identity. A process crash
 * after claim leaves the lock in place, so the next invocation reports an
 * unresolved prior attempt instead of signing a second authorization.
 */
export function createPurchaseAttemptStore(
  dataDir: string = DATA_DIR,
): DurablePurchaseAttemptStoreV1 {
  const directory = join(dataDir, STORE_DIR_NAME);
  let lastPrunedAt = 0;

  function paths(preparedId: string) {
    const name = recordName(preparedId);
    return {
      record: join(directory, `${name}.json`),
      lock: join(directory, `${name}.lock`),
    };
  }

  function pruneOldUntouchedPreparations(now: number): void {
    let deleted = 0;
    let names: string[];
    try {
      names = readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .slice(0, MAX_PRUNE_SCAN);
    } catch {
      return;
    }
    for (const name of names) {
      if (deleted >= MAX_PRUNE_DELETE) break;
      const recordPath = join(directory, name);
      const lockPath = join(directory, `${name.slice(0, -5)}.lock`);
      let lockFd: number;
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
      } catch {
        continue;
      }
      try {
        const attempt = readAttempt(recordPath);
        if (attempt?.state !== "prepared") continue;
        const updatedAt = Date.parse(attempt.updatedAt);
        if (
          !Number.isFinite(updatedAt)
          || now - updatedAt < UNTOUCHED_PREPARATION_RETENTION_MS
        ) {
          continue;
        }
        try {
          unlinkSync(recordPath);
          deleted += 1;
        } catch {
          // A filesystem error leaves the preparation in place. Pruning is
          // housekeeping and never permission to weaken the idempotency gate.
        }
      } finally {
        closeSync(lockFd);
        releaseLock(lockPath);
      }
    }
  }

  function duplicate(
    recordPath: string,
    fallback: PurchaseAttemptStateV1 | "unknown" = "unknown",
  ): PurchaseAttemptClaimV1 {
    const existing = readAttempt(recordPath);
    return {
      acquired: false,
      state:
        existing?.state === "prepared"
          ? "unknown"
          : existing?.state ?? fallback,
      receipt: existing?.receipt ?? null,
    };
  }

  return {
    prepare(purchase) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const now = Date.now();
      if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) {
        lastPrunedAt = now;
        pruneOldUntouchedPreparations(now);
      }
      const target = paths(purchase.preparedId);
      let lockFd: number;
      try {
        lockFd = openSync(target.lock, "wx", 0o600);
      } catch {
        throw new Error("purchase_preparation_locked");
      }
      try {
        writeFileSync(
          lockFd,
          `${JSON.stringify({
            version: STORE_VERSION,
            preparedId: purchase.preparedId,
            preparingAt: new Date().toISOString(),
          })}\n`,
        );
      } finally {
        closeSync(lockFd);
      }

      try {
        const recordExists = existsSync(target.record);
        const existing = readAttempt(target.record);
        if (recordExists && !existing) {
          throw new Error("purchase_preparation_record_invalid");
        }
        const expectedPreparedFingerprint = preparedFingerprint(purchase);
        if (existing) {
          if (
            existing.preparedId !== purchase.preparedId
            || existing.preparedFingerprint !== expectedPreparedFingerprint
          ) {
            throw new Error("purchase_preparation_identity_conflict");
          }
          if (existing.state !== "prepared") {
            throw new Error("purchase_prepared_identity_already_used");
          }
          return;
        }

        writeAttempt(target.record, {
          version: STORE_VERSION,
          preparedId: purchase.preparedId,
          preparedFingerprint: expectedPreparedFingerprint,
          executionFingerprint: null,
          state: "prepared",
          updatedAt: new Date().toISOString(),
          receipt: null,
        });
      } finally {
        releaseLock(target.lock);
      }
    },

    begin(purchase) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = paths(purchase.preparedId);
      let lockFd: number;
      try {
        lockFd = openSync(target.lock, "wx", 0o600);
      } catch {
        return duplicate(target.record);
      }
      try {
        writeFileSync(
          lockFd,
          `${JSON.stringify({
            version: STORE_VERSION,
            preparedId: purchase.preparedId,
            claimedAt: new Date().toISOString(),
          })}\n`,
        );
      } finally {
        closeSync(lockFd);
      }

      const expectedPreparedFingerprint = preparedFingerprint(purchase);
      const expectedExecutionFingerprint = executionFingerprint(purchase);
      const recordExists = existsSync(target.record);
      const existing = readAttempt(target.record);
      if (recordExists && !existing) {
        releaseLock(target.lock);
        return {
          acquired: false,
          state: "unknown",
          receipt: null,
        };
      }
      if (
        !existing
        || existing.preparedFingerprint !== expectedPreparedFingerprint
        || existing.preparedId !== purchase.preparedId
        || (
          existing.state !== "prepared"
          && (
            existing.state !== "awaiting_action"
            || existing.executionFingerprint !== expectedExecutionFingerprint
          )
        )
      ) {
        releaseLock(target.lock);
        return {
          acquired: false,
          state:
            existing
            && existing.preparedFingerprint === expectedPreparedFingerprint
            && existing.state !== "prepared"
              ? existing.state
              : "unknown",
          receipt:
            existing
            && existing.preparedFingerprint === expectedPreparedFingerprint
              ? existing.receipt
              : null,
        };
      }

      writeAttempt(target.record, {
        version: STORE_VERSION,
        preparedId: purchase.preparedId,
        preparedFingerprint: expectedPreparedFingerprint,
        executionFingerprint: expectedExecutionFingerprint,
        state: "claimed",
        updatedAt: new Date().toISOString(),
        receipt: existing?.receipt ?? null,
      });
      return { acquired: true };
    },

    markDispatching(purchase) {
      const target = paths(purchase.preparedId);
      const existing = readAttempt(target.record);
      if (
        !existsSync(target.lock)
        || !existing
        || existing.preparedFingerprint !== preparedFingerprint(purchase)
        || existing.executionFingerprint !== executionFingerprint(purchase)
        || existing.state !== "claimed"
      ) {
        throw new Error("purchase_attempt_not_claimed");
      }
      writeAttempt(target.record, {
        ...existing,
        state: "dispatching",
        updatedAt: new Date().toISOString(),
      });
    },

    complete(purchase, state, receipt) {
      const target = paths(purchase.preparedId);
      const existing = readAttempt(target.record);
      if (
        !existsSync(target.lock)
        || !existing
        || existing.preparedFingerprint !== preparedFingerprint(purchase)
        || existing.executionFingerprint !== executionFingerprint(purchase)
        || !["claimed", "dispatching"].includes(existing.state)
      ) {
        throw new Error("purchase_attempt_not_claimed");
      }
      writeAttempt(target.record, {
        ...existing,
        state,
        updatedAt: new Date().toISOString(),
        receipt,
      });
      releaseLock(target.lock);
    },
  };
}
