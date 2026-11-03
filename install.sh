#!/bin/bash
# Copies this config into ~/.config/herdr-app. Files it replaces are kept as <file>~.
# Copied, not symlinked: Herdr runs these scripts outside the sandbox, and the sandbox
# only keeps agents from writing to Herdr's own folder, not to this checkout.
set -euo pipefail
cd "$(dirname "$0")"
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
[ -d "$app" ] || { echo "No $app: start the Herdr app once first." >&2; exit 1; }
for tool in jq sandbox-exec; do
  command -v "$tool" >/dev/null || { echo "Missing $tool." >&2; exit 1; }
done

rsync -rlptb agent sandbox usage browser layouts worktrees mods keys.json "$app/"
[ -f "$app/programs.json" ] && cp "$app/programs.json" "$app/programs.json~"
sed "s|__HOME__|$HOME|g" programs.json > "$app/programs.json"

echo "Installed into $app."
echo "Switch to the layout with cmd-shift-l (\"main-sandbox\"), and see README.md for the Claude status line."
