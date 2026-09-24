#!/usr/bin/env bash
# Linux/macOS entry point for the BANTWORKS MCP setup. Equivalent to
# setup.ps1 on Windows; routes every subcommand through the cross-platform
# Node implementation in scripts/cli/setup.mjs so behaviour and file formats
# match across platforms.
#
# Usage:
#   ./setup.sh                          Show help
#   ./setup.sh install                  Build/validate the MCP server bundle
#   ./setup.sh add-project "Name" /path/to/UnityProject
#   ./setup.sh list-projects
#   ./setup.sh set-active <index>
#   ./setup.sh remove-project <index>
#   ./setup.sh set-profile <name>
#   ./setup.sh apply-claude
#   ./setup.sh apply-claude-desktop
#   ./setup.sh apply-codex
#   ./setup.sh apply-antigravity
#   ./setup.sh apply-opencode
#   ./setup.sh install-bridge
#   ./setup.sh config-path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="${SCRIPT_DIR}/scripts/cli/setup.mjs"

if [ ! -f "${NODE_SCRIPT}" ]; then
  echo "error: ${NODE_SCRIPT} not found." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js 20 or newer is required but 'node' was not found on PATH." >&2
  exit 1
fi

NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "${NODE_MAJOR}" -lt 20 ] 2>/dev/null; then
  echo "error: Node.js 20 or newer is required; found ${NODE_VERSION}." >&2
  exit 1
fi

exec node "${NODE_SCRIPT}" "$@"