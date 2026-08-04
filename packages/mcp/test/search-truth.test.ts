import { afterEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  capabilitySearch: vi.fn(),
  buildSearchResponse: vi.fn(),
  buildSearchErrorResponse: vi.fn(),
}));

vi.mock("@dexterai/x402-core", () => core);

import { cliSearch } from "../src/tools/search.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("OpenDexter CLI search truth", () => {
  it("prints the canonical tiered response without rebuilding or truncating it", async () => {
    const capabilityResult = {
      strongResults: [{ resourceId: "strong-1" }],
      relatedResults: [{ resourceId: "related-1" }],
    };
    const canonical = {
      success: true,
      count: 2,
      strongResults: capabilityResult.strongResults,
      relatedResults: capabilityResult.relatedResults,
      rankingMode: "degraded",
      degradedMessage: "Semantic ranking is temporarily unavailable.",
      searchMeta: {
        rankingMode: "degraded",
        degradedMessage: "Semantic ranking is temporarily unavailable.",
      },
      confidence: { profileCoverage: 0.5 },
      tip: "Treat this order as fallback ranking.",
    };
    core.capabilitySearch.mockResolvedValue(capabilityResult);
    core.buildSearchResponse.mockReturnValue(canonical);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await cliSearch("buy running shoes", { dev: false });

    expect(core.buildSearchResponse).toHaveBeenCalledWith(capabilityResult);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual(canonical);
  });

  it("prints the canonical degraded error contract instead of an ambiguous empty result", async () => {
    const canonicalError = {
      success: false,
      count: 0,
      strongResults: [],
      relatedResults: [],
      searchMeta: { mode: "error" },
      errorDetail: "search unavailable",
    };
    core.capabilitySearch.mockRejectedValue(new Error("search unavailable"));
    core.buildSearchErrorResponse.mockReturnValue(canonicalError);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process_exit");
    }) as never);

    await expect(cliSearch("buy running shoes", { dev: false })).rejects.toThrow(
      "process_exit",
    );

    expect(core.buildSearchErrorResponse).toHaveBeenCalledWith(
      "search unavailable",
    );
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual(canonicalError);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
