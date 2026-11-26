#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export PLUGIN_ROOT

resolve_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  local candidates=(
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "${ANTIGRAVITY_USER_DATA_DIR:-${HOME}/Library/Application Support/Antigravity}/bin/agy-node"
    "${ANTIGRAVITY_USER_DATA_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/Antigravity}/bin/agy-node"
  )

  if [ -d "${HOME}/.nvm/versions/node" ]; then
    while IFS= read -r bin_path; do
      candidates+=("${bin_path}")
    done < <(ls -1d "${HOME}"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -Vr)
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -x "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

NODE_BIN="$(resolve_node || true)"
if [ -z "${NODE_BIN}" ]; then
  echo "swarm-pi: could not locate node (or agy-node) executable in PATH, Homebrew, ~/.nvm, or Antigravity" >&2
  exit 1
fi

NODE_DIR="$(dirname "${NODE_BIN}")"
export PATH="${NODE_DIR}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

ENTRY_FILE="${PLUGIN_ROOT}/bin/server.bundle.mjs"
if [ ! -f "${ENTRY_FILE}" ]; then
  ENTRY_FILE="${PLUGIN_ROOT}/src/server.mjs"
fi

exec "${NODE_BIN}" "${ENTRY_FILE}" "$@"
