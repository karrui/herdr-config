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
# The chat's hooks in Claude Code's own settings, for a `claude` typed in a Herdr terminal
# (agent/claude-hooks): ours from an earlier install are replaced, the rest kept as they are.
claude_settings="$HOME/.claude/settings.json"
if [ -d "$HOME/.claude" ]; then
  [ -f "$claude_settings" ] && cp "$claude_settings" "$claude_settings~"
  merged="$({ cat "$claude_settings" 2>/dev/null || echo '{}'; } | jq --argjson h "$("$app/agent/claude-hooks")" '
    .hooks = reduce ($h.hooks | to_entries[]) as $e (
      (.hooks // {}) | map_values(map(select(any(.hooks[]?; (.command // "") | test("/mods/chat/(ask|event)-hook\\.sh")) | not)) | select(length > 0));
      .[$e.key] += $e.value)')"
  # In place, so a settings.json that links elsewhere (dotfiles) stays a link.
  printf '%s\n' "$merged" > "$claude_settings"
fi
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
