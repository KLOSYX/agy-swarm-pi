#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="swarm-pi"
MODE="install"
SCOPE="global"
WORKSPACE_DIR=""
TARGET_DIR=""

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --global                 Install to ~/.gemini/config/plugins/swarm-pi (default)
  --workspace <dir>        Install to <dir>/.agents/plugins/swarm-pi
  --target <dir>           Install directly to custom directory <dir>
  --uninstall              Remove installed plugin from the chosen target
  -h, --help               Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --global)
      SCOPE="global"
      shift
      ;;
    --workspace)
      [ $# -ge 2 ] || { echo "Missing argument for --workspace" >&2; exit 1; }
      SCOPE="workspace"
      WORKSPACE_DIR="$2"
      shift 2
      ;;
    --target)
      [ $# -ge 2 ] || { echo "Missing argument for --target" >&2; exit 1; }
      SCOPE="custom"
      TARGET_DIR="$2"
      shift 2
      ;;
    --uninstall)
      MODE="uninstall"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "${SCOPE}" = "global" ]; then
  TARGET_DIR="${HOME}/.gemini/config/plugins/${PLUGIN_NAME}"
elif [ "${SCOPE}" = "workspace" ]; then
  ABS_WS="$(cd "${WORKSPACE_DIR}" && pwd)"
  TARGET_DIR="${ABS_WS}/.agents/plugins/${PLUGIN_NAME}"
fi

if [ "${MODE}" = "uninstall" ]; then
  if [ -d "${TARGET_DIR}" ]; then
    rm -rf "${TARGET_DIR}"
    echo "Removed ${TARGET_DIR}"
  else
    echo "Not installed at ${TARGET_DIR}"
  fi
  exit 0
fi

if [ ! -f "${SRC_DIR}/plugin.json" ]; then
  echo "install.sh must reside inside the extracted swarm-pi plugin directory." >&2
  exit 1
fi

ABS_SRC="$(cd "${SRC_DIR}" && pwd)"
mkdir -p "$(dirname "${TARGET_DIR}")"
ABS_TARGET_PARENT="$(cd "$(dirname "${TARGET_DIR}")" && pwd)"
ABS_TARGET="${ABS_TARGET_PARENT}/$(basename "${TARGET_DIR}")"

if [ "${ABS_SRC}" = "${ABS_TARGET}" ]; then
  echo "Source and target are identical (${ABS_TARGET}); ensuring permissions."
else
  rm -rf "${ABS_TARGET}"
  mkdir -p "${ABS_TARGET}"
  for rel in \
    plugin.json \
    mcp_config.json \
    README.md \
    README.zh-CN.md \
    LICENSE \
    install.sh \
    assets \
    bin \
    skills \
    ui
  do
    if [ -e "${ABS_SRC}/${rel}" ]; then
      cp -R "${ABS_SRC}/${rel}" "${ABS_TARGET}/${rel}"
    fi
  done
fi

chmod +x "${ABS_TARGET}/install.sh" "${ABS_TARGET}/bin/start-server.sh"
echo "Installed ${PLUGIN_NAME} to ${ABS_TARGET}"

if command -v agy >/dev/null 2>&1; then
  agy plugin validate "${ABS_TARGET}" --strict >/dev/null && echo "Validated with agy plugin validate --strict."
fi
