#!/bin/sh
# Stands in for omo in the e2e test: no model call, it plays a lane that reads its brief, reports and finishes.
set -eu
dori() { sh -c "$DORI_E2E_CMD \"\$@\"" dori "$@"; }
brief=$(printf '%s' "$1" | sed -n 's/^Read your brief at \(.*\) and execute it\..*/\1/p')
test -f "$brief"
dori report "$DORI_LANE" --text "read brief: $(head -n 1 "$brief")"
dori ready "$DORI_LANE" --text "e2e lane finished" --evidence "file://$brief"
