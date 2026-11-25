// Herdr's live lists, read once per render. Herdr gives a render about 50 ms; past
// that it stops it and shows "This view could not be re-rendered". Each terminals(),
// panes(), spaces() or agents() call copies the whole list again (terminals() about 1 ms),
// and a render (with the helpers it calls, like parked.js) can ask for them dozens of times.
// Inside inRender() these give one copy per render; anywhere else (clicks, timers, spawned
// work) the live list, as before. The copies are shared by the whole render: never sort or
// change them in place.
// The same file is in mods/chat, agent-bar, agents-sandbox, artifacts, changes-sandbox,
// menu-hooks, pane-sandbox, space-folders, status-sandbox and tabs-sandbox (a mod imports
// only its own files): change them all together.
import { agents as liveAgents, panes as livePanes, terminals as liveTerminals, spaces as liveSpaces } from "herdr";

// The render's copies. A render Herdr stops runs no `finally`, so a copy older than any render
// can be (STALE ms) is never used.
const STALE = 250;
let frame = null;
const current = () => (frame && Date.now() - frame.at < STALE ? frame : null);
const once = (name, read) => () => {
  const f = current();
  if (!f) return read();
  if (!(name in f.lists)) f.lists[name] = read();
  return f.lists[name];
};

export const agents = once("agents", liveAgents);
export const panes = once("panes", livePanes);
export const terminals = once("terminals", liveTerminals);
export const spaces = once("spaces", liveSpaces);

// Runs fn (a render) with one copy of each list; a render inside another uses the outer one's.
export function inRender(fn) {
  const outer = current();
  frame = outer ?? { at: Date.now(), lists: {} };
  try { return fn(); } finally { frame = outer; }
}
