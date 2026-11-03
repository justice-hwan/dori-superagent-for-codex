#!/usr/bin/env bash
# Install this reviewed checkout. No implicit pull, service startup or messenger setup.
set -euo pipefail
src="${DORI_SRC:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"
bins="${DORI_BIN_DIR:-$HOME/.local/bin}"
for tool in bun codex; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done
(cd "$src" && bun install --frozen-lockfile --ignore-scripts && bun link)
mkdir -p "$bins"
if [ -e "$bins/dori-codex" ] && [ ! -L "$bins/dori-codex" ]; then
  echo "$bins/dori-codex already exists and is not a symlink; leaving it alone" >&2
else
  ln -sfn "$src/src/cli.ts" "$bins/dori-codex"
fi
mkdir -p "$skills"
if [ -e "$skills/dori-codex" ] && [ ! -L "$skills/dori-codex" ]; then
  echo "$skills/dori-codex already exists; leaving it alone" >&2
else
  ln -sfn "$src/skills/dori-codex" "$skills/dori-codex"
fi
echo "Installed from $src. CLI: $bins/dori-codex. Start explicitly with: dori-codex up --cwd /path/to/project"
