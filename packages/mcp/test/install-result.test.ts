import { afterEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({
  outro: vi.fn(),
  stop: vi.fn(),
}));
const wallet = vi.hoisted(() => ({
  loadOrCreateWallet: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: prompts.outro,
  select: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: prompts.stop }),
  log: {
    info: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../src/wallet/index.js", () => ({
  loadOrCreateWallet: wallet.loadOrCreateWallet,
}));

vi.mock("../src/cli/install/collision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/install/collision.js")>()),
  inspectExistingMcp: vi.fn(async () => ({
    state: "present" as const,
    kind: "remote_http" as const,
    disposition: "replace_existing" as const,
    detail: "hosted OpenDexter is already registered",
  })),
}));

import { runInstall } from "../src/cli/install/index.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("installer completion contract", () => {
  it("leaves a colliding client unchanged and reports installation incomplete", async () => {
    const result = await runInstall({
      client: "codex",
      yes: true,
      all: false,
      dev: false,
    });

    expect(result.complete).toBe(false);
    expect(result.successes).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/already exists in Codex/i);
    expect(prompts.outro).toHaveBeenCalledWith(
      expect.stringMatching(/was not installed/i),
    );
    expect(prompts.outro).not.toHaveBeenCalledWith(
      expect.stringMatching(/wired in/i),
    );
    expect(wallet.loadOrCreateWallet).not.toHaveBeenCalled();
  });
});
