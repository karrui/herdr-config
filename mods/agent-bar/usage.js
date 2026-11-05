// Usage data: Claude's status line writes usage/claude/<terminal>.json each turn; Codex's
// comes from its session file, read by usage/codex-usage. Both give
// { model, ctx, ctx_tokens, ctx_size, five, five_reset, week, week_reset, cost? }.
// herdr's exec takes an argv list and never goes through a shell.
import { exec as execFile, agents, terminals, appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";
import { chatAgents } from "./parked.js";

export const DIR = `${appHome()}/usage`;
export const CLAUDE = `${DIR}/claude`;

// Agents parked behind a chat pane aren't in agents(): chatAgents() adds them back.
export function agentAt(address) {
  return [...agents(), ...chatAgents()].find(a => a.address === address && (a.app === "claude-code" || a.app === "codex")) ?? null;
}

// Plan limits are account-wide: take them from whichever Claude session reported last,
// so an idle tab still shows what other sessions have spent.
async function claudeUsage(address) {
  const all = (await Promise.all((await fs.readdir(CLAUDE)).filter(f => f.endsWith(".json"))
    .map(async f => { try { return { f, u: JSON.parse(await readTextFile(`${CLAUDE}/${f}`)) }; } catch { return null; } })))
    .filter(Boolean);
  const own = all.find(x => x.f === `${address}.json`)?.u;
  if (!own) return null;
  const latest = all.reduce((a, b) => (b.u.at ?? 0) > (a.u.at ?? 0) ? b : a).u;
  const { five, five_reset, week, week_reset } = latest;
  return { ...own, five, five_reset, week, week_reset, limits_at: latest.at };
}

export async function loadUsage(agent) {
  try {
    if (agent?.app === "claude-code") return await claudeUsage(agent.address);
    if (agent?.app === "codex") {
      const pid = terminals().find(t => t.address === agent.address)?.pid;
      const u = JSON.parse((await execFile(`${DIR}/codex-usage`, [String(pid)])).stdout.trim() || "null");
      return u && { ...u, limits_at: u.at };
    }
  } catch { /* no reading yet */ }
  return null;
}

// Codex has no feed to watch, so it's read again whenever its agent changes (a turn ends).
export function usageKey(agent) {
  return agent ? `${agent.address}:${agent.app === "codex" ? `${agent.status}:${agent.seq}` : ""}` : null;
}

// A plan limit as last reported (at, in seconds): 0 once its window has reset since; stale when
// older than half an hour, as use elsewhere (the web, another machine) hasn't reached it.
const STALE = 1800;
export function limitShown(pct, reset, at) {
  const now = Date.now() / 1000;
  if (reset && reset <= now) return { pct: 0, passed: true };
  if (at && now - at > STALE) return { pct, stale: true, ago: ago(at) };
  return { pct };
}
export function ago(sec) {
  const m = Math.floor((Date.now() / 1000 - sec) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}

export function tokens(n) {
  return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function resetAt(sec) {
  const d = new Date(sec * 1000), h = d.getHours();
  const time = `${String(h % 12 || 12).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return d.toDateString() === new Date().toDateString() ? time : `${DAYS[d.getDay()]} ${time}`;
}

// Text color for a share used: plain, then warning, then urgent.
export const level = (t, pct) => pct >= 90 ? t.blocked : pct >= 75 ? t.ansi3 : t.foreground;
