import { exec, readTextFile, appHome } from "herdr";

let source;
// Send the small reader with the request: remote chat works without a second mod installation.
export async function sessionIO(operation, args, machine) {
  source ??= await readTextFile(`${appHome()}/mods/chat/session.mjs`);
  if (!source) throw new Error("The chat session reader is missing.");
  const r = await exec("node", ["--input-type=module", "-e", source + "\nawait run(process.argv.slice(1));", "--", operation, ...args], { on: machine });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "The agent's machine did not answer.");
  return JSON.parse(r.stdout);
}
