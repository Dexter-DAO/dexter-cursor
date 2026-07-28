/**
 * CLI staleness self-check.
 *
 * A stale global install (`npm i -g @dexterai/opendexter` from months ago) will
 * happily print — and then choke on — hints for commands it does not have. The
 * tab lane shipped in 1.17; a box still on an older build would copy an
 * `opendexter tab connect …` hint and get "Unknown arguments". This module is
 * the antidote: it compares the running version to the npm registry's `latest`
 * and prints ONE plain line telling the user to upgrade.
 *
 * Two trigger points wire this in (see src/index.ts):
 *   - startup, throttled to at most once per day via a cached timestamp under
 *     the user's config dir (fire-and-forget — never awaited, never blocks); and
 *   - unknown-command parse errors, forced (bypasses the throttle, because the
 *     user just hit the exact failure this check exists to explain).
 *
 * Doctrine: this is best-effort telemetry-free courtesy. It must NEVER block a
 * command, NEVER crash the process, and NEVER emit anything on stdout (which on
 * the default `server` command carries the MCP JSON-RPC stream) — the notice
 * always goes to stderr. Offline, DNS failure, a slow registry, an unwritable
 * config dir: every one of those is swallowed silently.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { get as httpsGet } from "node:https";
import { DATA_DIR, VERSION } from "./config.js";

const PKG_NAME = "@dexterai/opendexter";
const CHECK_FILE = "version-check.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const NPM_TIMEOUT_MS = 2_000;
/** Guard against a hostile/huge registry body — the `latest` doc is tiny. */
const MAX_BODY_BYTES = 1_000_000;

export type StaleContext = "startup" | "unknown-command";

export interface StalenessDeps {
  /** Config dir for the throttle timestamp. Default: DATA_DIR (~/.dexterai-mcp). */
  configDir?: string;
  /** Injectable clock (tests). Default: Date.now. */
  now?: () => number;
  /**
   * Injectable network layer — resolves the registry `latest` version, or null
   * on any failure. Default: {@link fetchLatestVersion}. Tests stub this so the
   * throttle + offline-silent logic never touches the real network.
   */
  fetchLatest?: (
    pkg: string,
    timeoutMs: number,
    opts?: { unref?: boolean },
  ) => Promise<string | null>;
  /** Injectable sink for the one-line notice. Default: stderr. */
  log?: (line: string) => void;
  /** Override the running version (tests). Default: VERSION. */
  currentVersion?: string;
}

export interface CheckOptions extends StalenessDeps {
  /**
   * When true, skip the whole check (no network) if the cached timestamp shows
   * we already probed within the last day. When false, always probe.
   */
  throttle: boolean;
  context: StaleContext;
  /**
   * Fire-and-forget mode: unref the network socket so a best-effort background
   * probe can never keep a one-shot process alive or delay its exit. Use this
   * ONLY when the caller does not await the result (the startup probe). The
   * awaited unknown-command path must leave it false, or Node would treat the
   * loop as empty while awaiting an unref'd socket and exit before the notice.
   */
  background?: boolean;
}

/** Split a semver core into numeric segments, ignoring any `-pre`/`+build`. */
function parseVersion(v: string): number[] {
  const core = String(v).trim().replace(/^v/i, "").split(/[-+]/)[0];
  return core.split(".").map((seg) => {
    const n = parseInt(seg, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** True iff `latest` is a strictly-higher semver than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false; // equal → not newer
}

/** The one plain line. Ends with an immutable upgrade command in both contexts. */
export function staleNotice(latest: string, current: string, context: StaleContext): string {
  const upgrade = `run npm i -g ${PKG_NAME}@${latest}`;
  if (context === "unknown-command") {
    return `that command may need a newer OpenDexter — ${latest} is out, you're on ${current}; ${upgrade}`;
  }
  return `OpenDexter ${latest} is available — you're on ${current}; ${upgrade}`;
}

/** Read the last-checked epoch-ms from the throttle file, or null if absent/unreadable. */
function readLastCheck(file: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { lastCheckedAt?: unknown };
    const t = parsed?.lastCheckedAt;
    if (typeof t === "number" && Number.isFinite(t)) return t;
    if (typeof t === "string") {
      const p = Date.parse(t);
      return Number.isFinite(p) ? p : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the last-checked timestamp (synchronously, so a one-shot process that
 *  exits before the network settles still records the daily attempt). */
function recordCheck(file: string, now: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ lastCheckedAt: now, lastCheckedISO: new Date(now).toISOString() }, null, 2),
  );
}

/**
 * The real network layer: fetch the registry's `latest` dist-tag doc and return
 * its `version`, or null on any failure. Bounded by `timeoutMs`.
 *
 * With `opts.unref` the socket is unref'd so a fire-and-forget background probe
 * can NEVER keep a one-shot CLI process alive or delay its exit. The awaited
 * path must leave it ref'd — an unref'd socket would let Node treat the loop as
 * empty and exit 0 mid-await, before the caller can act on the result.
 */
export function fetchLatestVersion(
  pkg: string,
  timeoutMs: number,
  opts: { unref?: boolean } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const url = `https://registry.npmjs.org/${pkg}/latest`;
    const req = httpsGet(url, { headers: { accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return done(null);
      }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) req.destroy();
      });
      res.on("end", () => {
        try {
          const j = JSON.parse(raw) as { version?: unknown };
          done(typeof j.version === "string" ? j.version : null);
        } catch {
          done(null);
        }
      });
    });
    // Only a fire-and-forget probe unrefs — an awaited caller needs the loop
    // kept alive until the request settles.
    if (opts.unref) req.on("socket", (socket) => socket.unref());
    req.on("error", () => done(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(null);
    });
  });
}

/**
 * Compare the running version to the registry `latest` and, if we are behind,
 * print one line. Honors the once-per-day throttle when `throttle` is true.
 * Silent and non-throwing on every failure path.
 */
export async function checkStaleness(opts: CheckOptions): Promise<void> {
  const now = (opts.now ?? Date.now)();
  const configDir = opts.configDir ?? DATA_DIR;
  const file = join(configDir, CHECK_FILE);
  const current = opts.currentVersion ?? VERSION;

  if (opts.throttle) {
    const last = readLastCheck(file);
    if (last != null && now - last < DAY_MS) return; // probed recently — skip entirely
  }

  // Record the attempt up front so we probe at most once/day even when offline
  // or when a one-shot process exits before the network call settles. An
  // unwritable config dir is not fatal — we just lose the throttle, never the
  // command.
  try {
    recordCheck(file, now);
  } catch {
    /* config dir unwritable — probe anyway, just without a persisted throttle */
  }

  let latest: string | null = null;
  try {
    latest = await (opts.fetchLatest ?? fetchLatestVersion)(PKG_NAME, NPM_TIMEOUT_MS, {
      unref: !!opts.background,
    });
  } catch {
    return; // offline / DNS / timeout — silent, never crash
  }
  if (!latest || !isNewerVersion(latest, current)) return;

  const emit = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  emit(staleNotice(latest, current, opts.context));
}
