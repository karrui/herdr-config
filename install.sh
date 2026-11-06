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

rsync -rlptb --exclude '*.default.txt' agent sandbox usage browser layouts mods keys.json "$app/"
# Sandbox lists are each person's own: started from the defaults, never replaced.
for list in allow deny; do
  [ -e "$app/sandbox/$list.txt" ] || cp "sandbox/$list.default.txt" "$app/sandbox/$list.txt"
done
# herdr-artifact on the PATH, for agents (agent/instructions.md): the artifacts mod's.
mkdir -p "$HOME/.local/bin" && ln -sfn "$app/mods/artifacts/bin/herdr-artifact" "$HOME/.local/bin/herdr-artifact"
[ -f "$app/programs.json" ] && cp "$app/programs.json" "$app/programs.json~"
sed "s|__HOME__|$HOME|g" programs.json > "$app/programs.json"

echo "Installed into $app."
# The window picks the layout up at once; with no window open, it's there next start.
if herdr-app do layout.switch --name main-sandbox >/dev/null 2>&1; then
  echo "Switched the window to the main-sandbox layout."
else
  echo "Open Herdr and press cmd-shift-l until it shows the main-sandbox layout."
fi
command -v gh >/dev/null || echo "Optional: install gh and run gh auth login, for pull requests in the sidebar."
echo "Next: the Claude Code status line, in README.md."
