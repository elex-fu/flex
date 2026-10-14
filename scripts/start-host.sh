#!/usr/bin/env bash

set -Eeuo pipefail

# One-command local bootstrap for the Claude/Codex MVP Host.
#
# Supported overrides:
#   FLYX_WORKSPACE       Git workspace to expose to the selected Provider (defaults to fixture)
#   FLYX_PROVIDER        claude (default) or codex
#   FLYX_DB              SQLite database path (provider-specific by default)
#   FLYX_IDENTITY_DIR    Owner-only Host identity directory (default: DB parent/identity)
#   FLYX_CONNECTIVITY_MODE  local (default), tailscale, relay, or auto
#   FLYX_PUBLIC_BASE_URL  Explicit HTTPS origin; Tailscale mode verifies its Serve mapping
#   FLYX_RELAY_ENABLED=1 Enable optional Relay transport
#   FLYX_RELAY_URL       WSS Relay origin
#   FLYX_HOSTED_APP_URL  HTTPS hosted Web origin used in Relay pairing offers
#   FLYX_RELAY_REGISTRATION_TOKEN  Optional hosted relay registration credential
#   FLYX_CLAUDE_EXECUTABLE  Optional Claude Code executable override
#   FLYX_CODEX_EXECUTABLE   Optional Codex executable override
#   PORT                 Loopback HTTP port (defaults to 4173)
#   FLYX_SKIP_INSTALL=1  Skip pnpm install when dependencies are already ready
#   FLYX_SKIP_BUILD=1    Skip the production Web/Host build
#
# Security-sensitive flags such as FLYX_ALLOW_INSECURE_HTTP,
# FLYX_REQUIRE_PAIRING_CONFIRM and FLYX_REQUIRE_TAILSCALE_SERVE are deliberately
# not assigned here; callers must opt into those modes explicitly.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd -- "${ROOT_DIR}"

log() {
  printf '\n[flyx] %s\n' "$*"
}

fail() {
  printf '\n[flyx] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "未找到 Node.js。请安装 Node.js 22 或更高版本后重试。"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || fail "Node.js 版本过低（当前 $(node --version)），需要 22 或更高版本。"

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  # Node 22 normally ships Corepack. Using `corepack pnpm` avoids requiring a
  # global pnpm install while still honoring package.json's pinned version.
  PNPM=(corepack pnpm)
else
  fail "未找到 pnpm 或 Corepack。请安装 pnpm 11（或启用 Node.js Corepack）后重试。"
fi

"${PNPM[@]}" --version >/dev/null 2>&1 \
  || fail "无法运行 pnpm。请检查网络和 Corepack 配置后重试。"

workspace="${FLYX_WORKSPACE:-${ROOT_DIR}/packages/claude-fixtures}"
provider="${FLYX_PROVIDER:-claude}"
case "${provider}" in
  claude) default_database="${ROOT_DIR}/.flyx/mvp.sqlite" ;;
  codex) default_database="${ROOT_DIR}/.flyx/mvp-codex.sqlite" ;;
  *) fail "FLYX_PROVIDER 必须是 claude 或 codex（当前：${provider}）" ;;
esac
database="${FLYX_DB:-${default_database}}"
port="${PORT:-4173}"
management_command=false
case "${1:-start}" in
  devices|identity|help|--help|-h) management_command=true ;;
esac

if [[ "${FLYX_SKIP_INSTALL:-0}" != "1" && "${management_command}" == false ]]; then
  log "安装 pnpm 依赖"
  "${PNPM[@]}" install --frozen-lockfile
else
  log "使用已有依赖"
fi

if [[ "${FLYX_SKIP_BUILD:-0}" != "1" && "${management_command}" == false ]]; then
  log "构建 Host 和同源 Web"
  "${PNPM[@]}" build
else
  log "使用已有构建"
fi

if [[ "${management_command}" == true ]]; then
  log "运行本机 Host 管理命令"
else
  log "启动 Flyx MVP Host"
fi
printf '[flyx] Workspace: %s\n' "${workspace}"
printf '[flyx] Database:  %s\n' "${database}"
printf '[flyx] Provider:  %s\n' "${provider}"
if [[ "${management_command}" == false ]]; then
  printf '[flyx] Loopback:  http://127.0.0.1:%s\n' "${port}"
  printf '[flyx] 按 Ctrl-C 停止 Host；首次手机配对时请在此终端输入 y（60 秒内）。\n'
  if [[ "${FLYX_ALLOW_INSECURE_HTTP:-0}" == "1" ]]; then
    printf '[flyx] 当前显式启用 HTTP loopback 本机调试；此选项不能与远程 endpoint 一起使用。\n'
  else
    printf '[flyx] 手机访问：FLYX_CONNECTIVITY_MODE=tailscale 校验并发现 Serve HTTPS 地址；或显式启用 Relay。\n'
  fi
fi

exec env \
  FLYX_WORKSPACE="${workspace}" \
  FLYX_DB="${database}" \
  FLYX_PROVIDER="${provider}" \
  PORT="${port}" \
  "${PNPM[@]}" --filter @flyx/mvp-host start "$@"
