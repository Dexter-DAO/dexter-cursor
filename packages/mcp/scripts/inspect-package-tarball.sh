#!/usr/bin/env bash
# Inspect one exact local tarball. This never installs, publishes, or contacts
# a registry; package-provenance.mjs owns the complete file/type/hash policy.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /absolute/path/to/dexterai-opendexter-VERSION.tgz" >&2
  exit 2
fi

CANDIDATE_TARBALL=$1
if [[ ! -f "$CANDIDATE_TARBALL" ]]; then
  echo "Candidate tarball not found: $CANDIDATE_TARBALL" >&2
  exit 2
fi

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node "$SCRIPT_ROOT/package-provenance.mjs" inspect \
  --tarball "$CANDIDATE_TARBALL" \
  --package-root "$SCRIPT_ROOT/.."
