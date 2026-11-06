// Shared by chat, new-menu-sandbox and space-folders; keep the copies alike.
import { exec, knownAgents } from "herdr";

// Resolve our launcher on the agent's host; seatbelt is macOS-only.
export function remoteRun(run, app, platform) {
  const argv = [...run], at = argv.findIndex(x => /\/agent\/launch$/.test(x));
  if (at < 0) return argv;
  argv[at] = `${app}/agent/launch`;
  if (platform !== "Darwin" && argv[at + 1] === "--sandbox") {
    argv.splice(at + 1, 1);
    // Without seatbelt, use Codex's own configured policy instead of its nested-sandbox override.
    if (argv[at + 1] === "codex" && argv[at + 2] === "--sandbox" && argv[at + 3] === "danger-full-access") argv.splice(at + 2, 2);
  }
  return argv;
}

export async function availableAgents(machine) {
  const agents = await knownAgents({ on: machine });
  if (!machine) return agents;
  const result = await exec("sh", ["-c", 'app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"; printf "%s\\n" "$app"; uname -s; for c in claude codex; do command -v "$c" >/dev/null 2>&1 && printf "%s\\n" "$c"; done; [ -x "$app/agent/launch" ] && echo runtime; true'], { on: machine });
  if (result.code !== 0) throw new Error(result.stderr);
  const [app, platform, ...installed] = result.stdout.trim().split("\n");
  return agents.map(a => /^(claude|codex)(-|$)/.test(a.key ?? "") && a.run.some(x => /\/agent\/launch$/.test(x))
    ? { ...a, run: remoteRun(a.run, app, platform), installed: installed.includes(a.key.startsWith("claude") ? "claude" : "codex") && installed.includes("runtime") } : a);
}
