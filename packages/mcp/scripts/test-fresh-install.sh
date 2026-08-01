#!/usr/bin/env bash
# Compatibility entrypoint retained for callers that previously used this name.
# Local tarballs are inspected only; a true fresh install must name an exact
# published version through test-registry-install.sh.
set -euo pipefail
SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec "$SCRIPT_ROOT/inspect-package-tarball.sh" "$@"
