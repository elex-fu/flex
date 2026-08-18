#!/usr/bin/env bash

set -Eeuo pipefail

# One-command local bootstrap for the Claude-only MVP Host.
#
# Supported overrides:
#   FLYX_WORKSPACE       Git workspace to expose to Claude (defaults to fixture)
#   FLYX_DB              SQLite database path (defaults to .flyx/mvp.sqlite)
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
database="${FLYX_DB:-${ROOT_DIR}/.flyx/mvp.sqlite}"
port="${PORT:-4173}"

if [[ "${FLYX_SKIP_INSTALL:-0}" != "1" ]]; then
  log "安装 pnpm 依赖"
  "${PNPM[@]}" install --frozen-lockfile
else
  log "跳过依赖安装（FLYX_SKIP_INSTALL=1）"
fi

if [[ "${FLYX_SKIP_BUILD:-0}" != "1" ]]; then
  log "构建 Host 和同源 Web"
  "${PNPM[@]}" build
else
  log "跳过构建（FLYX_SKIP_BUILD=1）"
fi

log "启动 Flyx MVP Host"
printf '[flyx] Workspace: %s\n' "${workspace}"
printf '[flyx] Database:  %s\n' "${database}"
printf '[flyx] URL:       http://127.0.0.1:%s\n' "${port}"
printf '[flyx] 按 Ctrl-C 停止 Host；首次手机配对时请在此终端输入 y。\n'
if [[ "${FLYX_ALLOW_INSECURE_HTTP:-0}" == "1" ]]; then
  printf '[flyx] WARNING: 当前启用了不安全 HTTP，仅用于 loopback 本机调试。\n'
else
  printf '[flyx] 通过 Tailscale Serve/HTTPS 访问；本机直连 HTTP 调试需显式设置 FLYX_ALLOW_INSECURE_HTTP=1。\n'
fi

exec env \
  FLYX_WORKSPACE="${workspace}" \
  FLYX_DB="${database}" \
  PORT="${port}" \
  "${PNPM[@]}" --filter @flyx/mvp-host start
