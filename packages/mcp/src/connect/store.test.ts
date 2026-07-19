import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadSession, saveSession, clearSession, type VaultSession } from "./store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dexterai-vault-store-test-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function makeSession(over: Partial<VaultSession> = {}): VaultSession {
  return {
    version: 1,
    accessToken: "at_live_123",
    refreshToken: "rt_live_456",
    vaultAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    vaultPda: "5FHwkrdxDCFAAVGYWKuf3dPuAMSjmgKKtBjxHVnJ2yZg",
    expiresAt: Date.now() + 3600_000,
    deviceLabel: "branch-laptop",
    ...over,
  };
}

describe("connect/store — vault session custody", () => {
  it("round-trips save -> load", () => {
    const session = makeSession();
    saveSession(session, dir);
    expect(loadSession(dir)).toEqual(session);
  });

  it("returns null when no session file has ever been written", () => {
    expect(loadSession(dir)).toBeNull();
  });

  it("clearSession removes the file; a subsequent load returns null", () => {
    saveSession(makeSession(), dir);
    expect(existsSync(join(dir, "vault.json"))).toBe(true);
    clearSession(dir);
    expect(existsSync(join(dir, "vault.json"))).toBe(false);
    expect(loadSession(dir)).toBeNull();
  });

  it("clearSession is a no-op (does not throw) when no file exists", () => {
    expect(() => clearSession(dir)).not.toThrow();
    expect(loadSession(dir)).toBeNull();
  });

  it("a hand-written corrupt file loads as null, never throws", () => {
    const file = join(dir, "vault.json");
    writeFileSync(file, "{not valid json", { mode: 0o600 });
    expect(() => loadSession(dir)).not.toThrow();
    expect(loadSession(dir)).toBeNull();
  });

  it("writes the file at 0600 after save", () => {
    saveSession(makeSession(), dir);
    const file = join(dir, "vault.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("writes the parent dir at 0700", () => {
    saveSession(makeSession(), dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("re-saving overwrites atomically: no lingering .tmp file, latest content wins", () => {
    saveSession(makeSession({ deviceLabel: "first" }), dir);
    saveSession(makeSession({ deviceLabel: "second" }), dir);
    expect(loadSession(dir)?.deviceLabel).toBe("second");
    const entries = require("node:fs").readdirSync(dir);
    expect(entries.filter((f: string) => f.includes(".tmp"))).toEqual([]);
  });
});
