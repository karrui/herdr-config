import { exec, hc, readTextFile, appHome } from "herdr";

// Cross-machine hc forwarding attributes even a desktop caller as an agent sender.
export function sendInput(terminal, text) {
  const at = terminal.indexOf("/");
  return at < 0 ? hc(["send", terminal, text])
    : exec("hc", ["send", terminal.slice(at + 1), text], { on: terminal.slice(0, at) });
}

let source;
// Send the small reader with the request: remote chat works without a second mod installation.
export async function sessionIO(operation, args, machine) {
  source ??= await readTextFile(`${appHome()}/mods/chat/session.mjs`);
  if (!source) throw new Error("The chat session reader is missing.");
  const r = await exec("node", ["--input-type=module", "-e", source + "\nawait run(process.argv.slice(1));", "--", operation, ...args], { on: machine });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "The agent's machine did not answer.");
  return JSON.parse(r.stdout);
}
