#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MESSAGE =
  "Local OpenDexter publishing is disabled. Tag the exact package version "
  + "with opendexter-v<version>; .github/workflows/publish-opendexter.yml "
  + "will test, build, and pack once, then wait for the single "
  + "opendexter-npm-production approval before OIDC publication.";

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
