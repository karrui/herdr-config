// Sandbox data: sandbox/agent-sandbox writes one blocked/<run>.tsv per sandboxed launch
// (time, process(pid), operation, path) and reads allow.txt, the whitelist.
// herdr's exec takes an argv list and never goes through a shell.
import { exec as execFile, terminals, home, appHome, readTextFile, writeTextFile, openOverlay } from "herdr";

export const DIR = `${appHome()}/sandbox`;
export const BLOCKED = `${DIR}/blocked`;
export const ALLOW = `${DIR}/allow.txt`;

// The run a terminal is in, from the label agent-sandbox sets while it runs.
export function runOf(address) {
  return terminals().find(t => t.address === address)?.labels?.["herdr.sandbox"] || null;
}

// One entry per (operation, path): how often, when last, by which process.
export async function loadBlocked(run) {
  const r = await execFile("/usr/bin/awk", ["-F\t",
    "{ k = $3 FS $4; n[k]++; t[k] = $1; p[k] = $2 } END { for (k in n) print t[k] FS n[k] FS p[k] FS k }",
    `${BLOCKED}/${run}.tsv`]);
  return r.stdout.split("\n").filter(Boolean).map(line => {
    const [time, count, proc, op, path] = line.split("\t");
    return { time: Number(time), count: Number(count), proc, op, path };
  }).sort((a, b) => b.time - a.time);
}

const expand = p => p.startsWith("~/") ? home() + p.slice(1) : p;

export async function loadRules() {
  return (await readTextFile(ALLOW) ?? "").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
    .map(l => { const [mode, ...rest] = l.split(/\s+/); return { mode, path: expand(rest.join(" ")) }; });
}

export const needsWrite = op => op.startsWith("file-write");

export function allowed(rules, entry) {
  return rules.some(r => (r.mode === "rw" || (r.mode === "ro" && !needsWrite(entry.op)))
    && (entry.path === r.path || entry.path.startsWith(r.path + "/")));
}

// "$HOME" and the parts under it, or "" and the parts under / for paths elsewhere.
export function splitPath(path) {
  const inHome = path.startsWith(home() + "/");
  return { root: inHome ? "$HOME" : "", prefix: inHome ? "~/" : "/", parts: path.slice(inHome ? home().length + 1 : 1).split("/") };
}

// Whitelists the entry's path up to its part `upto`: rw for a blocked write, ro for a read.
export async function allowUpTo(entry, upto) {
  const { prefix, parts } = splitPath(entry.path);
  const current = await readTextFile(ALLOW);
  const line = `${needsWrite(entry.op) ? "rw" : "ro"} ${prefix}${parts.slice(0, upto + 1).join("/")}`;
  if (!(current ?? "").split("\n").some(l => l.trim() === line))
    await writeTextFile(ALLOW, `${(current ?? "").replace(/\n*$/, "\n")}${line}\n`, current);
}

// The window editing allow.txt and deny.txt (mods/sandbox-lists).
export function openSandboxLists() {
  return openOverlay({ mod: "sandbox-lists", kind: "window", key: "sandbox-lists", width: 620, height: 600 });
}
