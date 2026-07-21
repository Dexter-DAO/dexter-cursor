import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DOCS_ASSETS_DIR } from "../src/resources/docs.js";

describe("docs resources", () => {
  it("docs assets ship with the package", () => {
    for (const f of ["workflow.md", "protocol.md", "debugging.md"]) {
      expect(existsSync(join(DOCS_ASSETS_DIR, f))).toBe(true);
    }
  });
});
