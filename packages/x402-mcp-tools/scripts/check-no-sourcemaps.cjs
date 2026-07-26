#!/usr/bin/env node
/**
 * prepublishOnly guardrail.
 *
 * Aborts `npm publish` if any sourcemap files exist anywhere in the
 * package's publishable surface. Sourcemaps would expose the original
 * TS source, comments, and architecture to anyone who runs
 * `npm install` — which defeats the point of distributing built JS.
 *
 * If a sourcemap shows up here, do NOT just delete it — figure out
 * which build flag put it there and remove the flag. Otherwise it'll
 * come back next build.
 */
const { readdirSync, statSync } = require("node:fs");
const { join, relative } = require("node:path");

const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

let files = [];
try {
  files = walk(DIST);
} catch (err) {
  console.error(`[check-no-sourcemaps] dist/ unreadable: ${err.message}`);
  process.exit(1);
}

const found = files.filter((f) => f.endsWith(".map"));
if (found.length > 0) {
  console.error("[check-no-sourcemaps] ABORTING: sourcemaps found in dist/");
  for (const f of found) console.error("  - " + relative(ROOT, f));
  console.error("");
  console.error("Sourcemaps must NOT be published. Remove --sourcemap from");
  console.error("the build script and rebuild.");
  process.exit(1);
}

const retiredRegistrars = files.filter((file) =>
  /(?:^|[/\\])(?:compose-cards|card-widget-meta)\.d\.ts$|[/\\]tools[/\\]cards[/\\]/.test(
    relative(ROOT, file),
  ),
);
if (retiredRegistrars.length > 0) {
  console.error(
    "[check-no-sourcemaps] ABORTING: retired Dextercard registrar declarations found in dist/",
  );
  for (const file of retiredRegistrars) {
    console.error("  - " + relative(ROOT, file));
  }
  process.exit(1);
}

console.log("[check-no-sourcemaps] dist/ has no sourcemaps or card registrar declarations ✓");
