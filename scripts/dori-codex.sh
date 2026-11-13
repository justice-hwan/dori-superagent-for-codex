#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export DORI_HOME="${DORI_HOME:-$HOME/.dori-codex}"
export DORI_RUNTIME=codex
export DORI_CMD="/bin/sh \"$ROOT/scripts/dori-codex.sh\""
exec "${BUN_BIN:-bun}" "$ROOT/src/cli.ts" "$@"
