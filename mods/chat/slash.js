// Slash commands for the "/" list above the message box. Whatever the person types goes to
// the agent as typed; this only suggests. A command that opens a menu in the CLI (no
// arguments given) needs the terminal, so the chat switches to it after sending.

import { exec } from "herdr";

const CLAUDE = [
  ["add-dir", "Add a working folder"], ["agents", "Manage subagents"], ["btw", "Ask a side question (its answer opens over the chat)"], ["clear", "Start a new conversation"],
  ["compact", "Summarize the conversation to free context"], ["config", "Open settings"], ["context", "Show context use"],
  ["cost", "Show this session's cost"], ["doctor", "Check the installation"], ["effort", "Set the effort level"],
  ["export", "Export the conversation"], ["fast", "Turn fast mode on or off"], ["help", "Show help"], ["hooks", "Manage hooks"],
  ["init", "Write a CLAUDE.md for this project"], ["login", "Sign in"], ["logout", "Sign out"], ["mcp", "Manage MCP servers"],
  ["memory", "Edit memory files"], ["model", "Choose the model"], ["permissions", "Manage tool permissions"],
  ["plugin", "Manage plugins"], ["resume", "Resume another conversation"], ["review", "Review a pull request"],
  ["rewind", "Go back to an earlier point"], ["status", "Show version, model and account"], ["theme", "Change the theme"],
  ["usage", "Show plan usage"],
];
const CODEX = [
  ["model", "Choose the model and effort"], ["approvals", "Choose what runs without asking"], ["review", "Review changes"],
  ["new", "Start a new conversation"], ["init", "Write an AGENTS.md for this project"], ["compact", "Summarize the conversation to free context"],
  ["diff", "Show the git diff"], ["mention", "Mention a file"], ["status", "Show session settings and usage"],
  ["mcp", "List MCP tools"], ["resume", "Resume another conversation"], ["fork", "Fork this conversation"],
  ["logout", "Sign out"], ["quit", "Exit Codex"],
];
// Commands that open a menu in the CLI when given no arguments.
const MENU = {
  claude: new Set(["agents", "config", "doctor", "effort", "export", "hooks", "login", "mcp", "memory", "model", "permissions", "plugin", "resume", "rewind", "status", "theme", "usage"]),
  codex: new Set(["model", "approvals", "review", "mention", "resume", "fork", "status", "diff"]),
};

// The person's own commands and skills, on the agent's machine: "c|s<TAB>name<TAB>description"
// lines (c a command, s a skill). Claude Code: ~/.claude and the project's commands and skills,
// and those of enabled plugins as plugin:name. Codex: its skills (invoked as $name) and custom
// prompts (/prompts:name). Skills marked user-invocable: false are left out.
const SCAN = `
cwd="$1"; kind="$2"
desc() { awk '/^description:/ { sub(/^description:[[:space:]]*/, ""); if ($0 ~ /^[>|]-?$/ || $0 == "") { getline; sub(/^[[:space:]]+/, "") } gsub(/[\\\\"]/, ""); print substr($0, 1, 90); exit }' "$1" 2>/dev/null; }
skills() { pre="$1"; shift; for d in "$@"; do for f in "$d"/*/SKILL.md; do [ -f "$f" ] || continue; grep -qE '^user-invocable:[[:space:]]*false' "$f" && continue; n=\${f%/SKILL.md}; printf 's\\t%s%s\\t%s\\n' "$pre" "\${n##*/}" "$(desc "$f")"; done; done; }
cmds() { pre="$1"; d="$2"; [ -d "$d" ] || return 0; find "$d" -name '*.md' 2>/dev/null | while read -r f; do n=\${f#"$d"/}; n=\${n%.md}; printf 'c\\t%s%s\\t%s\\n' "$pre" "$(echo "$n" | tr / :)" "$(desc "$f")"; done; }
if [ "$kind" = codex ]; then
  c="\${CODEX_HOME:-$HOME/.codex}"
  skills "" "$HOME/.agents/skills" "$c/skills" "$cwd/.agents/skills" "$cwd/.codex/skills"
  cmds "prompts:" "$c/prompts"
else
  cmds "" "$HOME/.claude/commands"; cmds "" "$cwd/.claude/commands"
  skills "" "$HOME/.claude/skills" "$cwd/.claude/skills"
  i="$HOME/.claude/plugins/installed_plugins.json"
  if command -v jq >/dev/null && [ -f "$i" ]; then
    jq -r --slurpfile s "$HOME/.claude/settings.json" '.plugins | to_entries[] | select($s[0].enabledPlugins[.key] == true) | "\\(.key | split("@")[0])\\t\\(.value[0].installPath)"' "$i" 2>/dev/null |
      while IFS="$(printf '\\t')" read -r p d; do skills "$p:" "$d/skills"; cmds "$p:" "$d/commands"; done
  fi
fi
true`;

const cache = new Map();
// Every command this agent knows: [{ name, about, skill? }], built-in first. Cached per machine
// and folder.
export async function commands(kind, machine, cwd) {
  const own = kind === "codex" ? CODEX : CLAUDE;
  const list = own.map(([name, about]) => ({ name, about }));
  const k = `${kind}|${machine ?? ""}|${cwd ?? ""}`;
  if (!cache.has(k)) {
    cache.set(k, exec("sh", ["-c", SCAN, "scan", cwd ?? "", kind], { on: machine }).then((r) => r.stdout.split("\n").filter(Boolean).map((l) => {
      const [type, name, about] = l.split("\t");
      return { name, about: about || (type === "s" ? "Your skill" : "Your command"), skill: type === "s" };
    }).filter((c) => c.name)).catch(() => []));
  }
  const mine = await cache.get(k);
  const seen = new Set(list.map((c) => c.name));
  return [...list, ...mine.filter((c) => !seen.has(c.name) && seen.add(c.name))];
}

// What is being typed for the list: "/word" when the whole message is one command so far, or
// "$word" at its end (Codex takes a skill anywhere in a message). { sigil, word } or null.
export function typing(text) {
  const m = /^\/([\w:.-]*)$/.exec(text);
  if (m) return { sigil: "/", word: m[1] };
  const d = /(?:^|\s)\$([\w:.-]*)$/.exec(text);
  return d ? { sigil: "$", word: d[1] } : null;
}

// Suggestions for what is typed: names that start with it first, then names that contain it.
export function match(list, word) {
  const w = word.toLowerCase();
  const starts = list.filter((c) => c.name.toLowerCase().startsWith(w));
  const has = list.filter((c) => !c.name.toLowerCase().startsWith(w) && c.name.toLowerCase().includes(w));
  return [...starts, ...has].slice(0, 8);
}

// A sent message that opens a menu in the CLI: its command name, else null.
export function opensMenu(kind, text) {
  const m = /^\/([\w:-]+)\s*$/.exec(text.trim());
  if (!m) return null;
  if (MENU[kind]?.has(m[1])) return m[1];
  // The CLI completes a prefix to its first match ("/mo" runs /model).
  const all = (kind === "codex" ? CODEX : CLAUDE).map(([n]) => n).filter((n) => n.startsWith(m[1]));
  return all.length && MENU[kind]?.has(all[0]) ? all[0] : null;
}
