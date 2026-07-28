import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkStaleness,
  isNewerVersion,
  staleNotice,
  type StaleContext,
} from "../src/staleness.js";

const CHECK_FILE = "version-check.json";
const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "odx-stale-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A collecting logger + the network spy, wired to a fixed clock and temp dir. */
function harness(opts: {
  latest: string | null | (() => Promise<string | null>);
  current: string;
  now: number;
  throttle: boolean;
  context?: StaleContext;
}) {
  const lines: string[] = [];
  const fetchLatest = vi.fn(async () => {
    if (typeof opts.latest === "function") return opts.latest();
    return opts.latest;
  });
  const run = () =>
    checkStaleness({
      throttle: opts.throttle,
      context: opts.context ?? "startup",
      configDir: dir,
      now: () => opts.now,
      currentVersion: opts.current,
      fetchLatest,
      log: (l) => lines.push(l),
    });
  return { lines, fetchLatest, run };
}

function writeTimestamp(when: number) {
  writeFileSync(join(dir, CHECK_FILE), JSON.stringify({ lastCheckedAt: when }));
}

describe("isNewerVersion", () => {
  it("detects a higher minor/patch/major", () => {
    expect(isNewerVersion("1.17.0", "1.0.3")).toBe(true);
    expect(isNewerVersion("1.18.0", "1.17.9")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.0.4", "1.0.3")).toBe(true);
  });
  it("returns false for equal or older", () => {
    expect(isNewerVersion("1.18.0", "1.18.0")).toBe(false);
    expect(isNewerVersion("1.0.3", "1.17.0")).toBe(false);
    expect(isNewerVersion("1.17.0", "1.18.0")).toBe(false);
  });
  it("ignores prerelease/build metadata and a v-prefix", () => {
    expect(isNewerVersion("v1.18.0", "1.17.0")).toBe(true);
    expect(isNewerVersion("1.18.0-beta.1", "1.18.0")).toBe(false);
    expect(isNewerVersion("1.19.0+build.5", "1.18.0")).toBe(true);
  });
});

describe("staleNotice", () => {
  it("always ends with the immutable global-upgrade command", () => {
    for (const ctx of ["startup", "unknown-command"] as StaleContext[]) {
      const line = staleNotice("1.17.0", "1.0.3", ctx);
      expect(line).toContain("npm i -g @dexterai/opendexter@1.17.0");
      expect(line).not.toContain("@latest");
      expect(line).toContain("1.17.0");
      expect(line).toContain("1.0.3");
      expect(line.split("\n")).toHaveLength(1); // one plain line
    }
  });
});

describe("checkStaleness throttle", () => {
  it("skips the network entirely when checked within the last day", async () => {
    const now = 1_000 * DAY_MS;
    writeTimestamp(now - DAY_MS / 2); // half a day ago
    const { fetchLatest, lines, run } = harness({
      latest: "9.9.9",
      current: "1.0.0",
      now,
      throttle: true,
    });
    await run();
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("probes again once the day has elapsed", async () => {
    const now = 1_000 * DAY_MS;
    writeTimestamp(now - DAY_MS - 1); // just over a day ago
    const { fetchLatest, run } = harness({
      latest: "1.0.0",
      current: "1.0.0",
      now,
      throttle: true,
    });
    await run();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("probes when no timestamp file exists yet, and records the attempt", async () => {
    const now = 1_000 * DAY_MS;
    expect(existsSync(join(dir, CHECK_FILE))).toBe(false);
    const { fetchLatest, run } = harness({
      latest: "1.0.0",
      current: "1.0.0",
      now,
      throttle: true,
    });
    await run();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(readFileSync(join(dir, CHECK_FILE), "utf8"));
    expect(saved.lastCheckedAt).toBe(now);
  });

  it("forced (throttle:false) probes even with a fresh timestamp", async () => {
    const now = 1_000 * DAY_MS;
    writeTimestamp(now); // checked this very instant
    const { fetchLatest, run } = harness({
      latest: "1.0.0",
      current: "1.0.0",
      now,
      throttle: false,
      context: "unknown-command",
    });
    await run();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });
});

describe("checkStaleness offline-silent", () => {
  it("never throws and never logs when the probe rejects (offline)", async () => {
    const now = 1_000 * DAY_MS;
    const { lines, run } = harness({
      latest: () => Promise.reject(new Error("ENOTFOUND registry.npmjs.org")),
      current: "1.0.0",
      now,
      throttle: true,
    });
    await expect(run()).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("stays silent when the probe times out to null", async () => {
    const now = 1_000 * DAY_MS;
    const { lines, run } = harness({
      latest: null, // what fetchLatestVersion returns on timeout/error
      current: "1.0.0",
      now,
      throttle: true,
    });
    await run();
    expect(lines).toEqual([]);
  });

  it("still records the daily attempt even when offline", async () => {
    const now = 1_000 * DAY_MS;
    const { run } = harness({
      latest: () => Promise.reject(new Error("offline")),
      current: "1.0.0",
      now,
      throttle: true,
    });
    await run();
    const saved = JSON.parse(readFileSync(join(dir, CHECK_FILE), "utf8"));
    expect(saved.lastCheckedAt).toBe(now); // one attempt/day even offline
  });
});

describe("checkStaleness notice", () => {
  it("prints exactly one upgrade line when a newer version exists", async () => {
    const now = 1_000 * DAY_MS;
    const { lines, run } = harness({
      latest: "1.17.0",
      current: "1.0.3",
      now,
      throttle: true,
    });
    await run();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("npm i -g @dexterai/opendexter@1.17.0");
    expect(lines[0]).not.toContain("@latest");
    expect(lines[0]).toContain("1.17.0");
    expect(lines[0]).toContain("1.0.3");
  });

  it("says nothing when already on the latest version", async () => {
    const now = 1_000 * DAY_MS;
    const { lines, run } = harness({
      latest: "1.18.0",
      current: "1.18.0",
      now,
      throttle: true,
    });
    await run();
    expect(lines).toEqual([]);
  });

  it("says nothing when the running version is ahead of the registry", async () => {
    const now = 1_000 * DAY_MS;
    const { lines, run } = harness({
      latest: "1.18.0",
      current: "1.19.0",
      now,
      throttle: true,
    });
    await run();
    expect(lines).toEqual([]);
  });
});

describe("checkStaleness socket lifetime", () => {
  // Regression guard: the awaited unknown-command path MUST keep the socket
  // ref'd. An unref'd socket lets Node treat the loop as empty mid-await and
  // exit 0 before process.exit(1) runs — the CLI would swallow its own failure.
  it("awaited path asks fetchLatest NOT to unref", async () => {
    const now = 1_000 * DAY_MS;
    const fetchLatest = vi.fn(async () => "1.0.0");
    await checkStaleness({
      throttle: false,
      context: "unknown-command",
      configDir: dir,
      now: () => now,
      currentVersion: "1.0.0",
      fetchLatest,
      log: () => {},
    });
    expect(fetchLatest).toHaveBeenCalledWith("@dexterai/opendexter", 2000, { unref: false });
  });

  it("fire-and-forget startup path asks fetchLatest to unref", async () => {
    const now = 1_000 * DAY_MS;
    const fetchLatest = vi.fn(async () => "1.0.0");
    await checkStaleness({
      throttle: true,
      context: "startup",
      background: true,
      configDir: dir,
      now: () => now,
      currentVersion: "1.0.0",
      fetchLatest,
      log: () => {},
    });
    expect(fetchLatest).toHaveBeenCalledWith("@dexterai/opendexter", 2000, { unref: true });
  });
});
