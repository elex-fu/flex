#!/usr/bin/env bash
set -Eeuo pipefail

# Production/service restart uses the already built artifact. It never invokes
# pnpm, Corepack, installs, builds, or a network bootstrap.
# Prepare a checkout explicitly with scripts/dev-bootstrap-host.sh first.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd -- "${ROOT_DIR}"

fail() { printf '[flyx] ERROR: %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || fail "Node.js 22 or newer is required."
artifact="${ROOT_DIR}/apps/mvp-host/dist/main.js"
[[ -f "${artifact}" ]] || fail "Built Host artifact is missing. Run scripts/dev-bootstrap-host.sh in a development checkout."

provider="${FLYX_PROVIDER:-claude}"
case "${provider}" in
  claude) default_database="${ROOT_DIR}/.flyx/mvp.sqlite" ;;
  codex) default_database="${ROOT_DIR}/.flyx/mvp-codex.sqlite" ;;
  *) fail "FLYX_PROVIDER must be claude or codex." ;;
esac
workspace="${FLYX_WORKSPACE:-${ROOT_DIR}/packages/claude-fixtures}"
database="${FLYX_DB:-${default_database}}"
port="${PORT:-4173}"
management_command=false
case "${1:-start}" in
  devices|identity|doctor|backup|restore|owner|help|--help|-h) management_command=true ;;
esac
if [[ "${management_command}" == false ]]; then
  [[ -f "${FLYX_WEB_ROOT:-${ROOT_DIR}/apps/mvp-web/dist}/index.html" ]] \
    || fail "Built Web artifact is missing. Run scripts/dev-bootstrap-host.sh in a development checkout."
  printf '[flyx] Starting built Host (%s) on loopback port %s\n' "${provider}" "${port}"
else
  printf '[flyx] Running built Host management command\n'
fi

# Security-sensitive connectivity/pairing overrides are supplied by the caller.
exec env FLYX_WORKSPACE="${workspace}" FLYX_DB="${database}" \
  FLYX_PROVIDER="${provider}" PORT="${port}" node "${artifact}" "$@"
