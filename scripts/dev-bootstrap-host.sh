#!/usr/bin/env bash
set -Eeuo pipefail

# Explicit development preparation; service restarts use start-host.sh directly.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd -- "${ROOT_DIR}"
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  printf '[flyx] pnpm or Corepack is required for development bootstrap.\n' >&2
  exit 1
fi
if [[ "${FLYX_SKIP_INSTALL:-0}" != "1" ]]; then "${PNPM[@]}" install --frozen-lockfile; fi
if [[ "${FLYX_SKIP_BUILD:-0}" != "1" ]]; then "${PNPM[@]}" build; fi
exec bash "${SCRIPT_DIR}/start-host.sh" "$@"
