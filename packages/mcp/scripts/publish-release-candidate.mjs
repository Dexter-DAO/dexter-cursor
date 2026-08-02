#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MESSAGE =
  "Local OpenDexter publishing is disabled. Dispatch the protected "
  + ".github/workflows/review-opendexter-release.yml evidence producer at "
  + "the exact release tag, then dispatch .github/workflows/publish-opendexter.yml. "
  + "Only its opendexter-npm-production OIDC job may publish the accepted tarball.";

export function main() {
  throw new Error(MESSAGE);
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`OpenDexter publish refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
