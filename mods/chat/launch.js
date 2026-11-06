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
