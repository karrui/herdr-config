// Chat: an agent's conversation as a chat, read from the agent's own session log, with a
// box to write to it. The agent keeps running in its terminal; this only shows it another way.
// Opened by the `pane-sandbox` header's Chat / Terminal switch in the agent pane's spot: the
// agent's terminal is parked (running, without a pane) while this shows.
// Props: { terminal }: the agent's address ("t7"). After a restart from here the chat follows
// the new agent: it carries herdr.chat.origin=<props terminal>.
// Or { transcript }: a helper's conversation, read-only (openHelper()).
//
// The box takes pasted or dropped files (attach.js), suggests slash commands (slash.js) and
// keeps an unsent draft per agent in data/chat-drafts. Under it, the model button says what the
// agent runs on and opens a picker (mods/chat-models) to restart it with other choices (agent.js).
// Hovering a message shows its actions in a small bar over its top corner: react, reply (quote),
// copy, and rewind (the CLI's own) or fork.
// A CLI stopped on its own first screen (trust, theme, sign in) shows it as a card to answer
// here (screens.js); an agent whose resumed session is gone starts a new one by itself
// (lostSession()); /model opens the model picker instead of reaching the CLI; long replies fold
// with Show more; a day's line (Today, Yesterday, ...) goes where a new day starts.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, VirtualListScrollHandle, TextView, v_virtual_list, InputState, Input } from "gpui-base";
import { focused, props, run, theme, hc, exec, shared, setShared, watchFolder, window, settings, playSound, appHome, readTextFile, writeTextFile, nextCommand, openOverlay, closeOverlay, knownAgents } from "herdr";
import { agents, panes, terminals, spaces, inRender } from "./live.js";
import * as fs from "fs/promises";
import { FIND, LOG, Conversation, records, resultText, summary, excerpt, names } from "./log.js";
import { words } from "./asks.js";
import { AskCards } from "./cards.js";
import * as strips from "./strips.js";
import { red, green, toast, toastWho, plainError } from "./ui.js";
import { openViewer } from "./artview.js";
import * as attach from "./attach.js";
import * as slash from "./slash.js";
import * as agent from "./agent.js";
import { ScreenWatch, screenStrips, openCard, cardsOf, starting, cliOf } from "./screens.js";
import { dayLabel, dayOf } from "./days.js";

// Messages a page of history holds: the newest page first, earlier ones as the person scrolls up.
const PAGE = 200;
// At most this many log records (and opened tool outputs) kept in memory per chat: past it, the
// oldest go (scrolling to the top reads them again).
const KEEP = 2000;
// The conversation's width at most, in px: lines stay readable in a wide pane.
const COLUMN = 760;
const KINDS = { "claude-code": "claude", claude: "claude", codex: "codex" };
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const same = (a, b) => norm(a) === norm(b);
// "45s", "4m 5s", "1h 2m": how long a turn worked.
const duration = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
// When an ask was made: its id is <terminal>.<seconds>.<pid> (ask-hook.sh), taken at the end of
// that second so it sits after what was said in it.
const askAt = (id) => { const p = String(id).split("."); const sec = Number(p[p.length - 2]); return Number.isFinite(sec) && sec > 1e9 ? sec * 1000 + 999 : Date.now(); };
// Why hc didn't do it: { kind, message } from its JSON error ("blocked": a dialog is open), else its words.
function refusal(r) {
  const text = String(r?.stderr || r?.stdout || "").trim();
  try { const e = JSON.parse(text).error; if (e?.message) return { kind: e.kind ?? null, message: e.message }; } catch {}
  return { kind: /"kind":"blocked"/.test(text) ? "blocked" : null, message: text || "It didn't go through." };
}
// The composer's round buttons (Attach, Send), and the height of its text row (one line of the
// box).
const ROUND = 28, TEXT_ROW = 34;
// Image thumbnails: the box's files are squares this many px, this far apart; under sent
// messages each image keeps its shape, fitted in THUMB_ONE (one image) or THUMB_MANY (w, h).
const THUMB = 56, THUMB_GAP = 6, THUMB_ONE = [320, 220], THUMB_MANY = [200, 140];
// ONE row under each message, its band (a list row of its own), on the message's side (left
// for the agent, right for the person), in this order: the time (dim), reply, copy, rewind or
// fork; then on the agent's the reaction pills and the smiley to add one, furthest right, and
// on the person's the smiley and then the pills, furthest right (flush under the bubble's
// edge). The pills always show; the rest only while the pointer is on the message, in room
// that is always kept, so nothing moves. barLayout() places every part; hitBar() reads the
// same places.
// One even rhythm on a 4 px scale (spaced()): under every message its band, always kept: BAND_IN
// of air under the bubble, then the actions' row (ACT tall, pills or not). Then every block (a
// message with its band, a run of quiet lines, a card) is GAP from the next, so the row never
// touches what follows and the room above a bubble is the room after a row.
const ACT = 22, ACT_GAP = 2, BAND_IN = 4, ACT_ROW = BAND_IN + ACT, GAP = 16;
// Quiet lines (tools, "Message from …", artifact lines) sit tight: each is its line with QUIET_PY
// above and below (a tools row's hover box), no more. QUIET_IN: how far their words' ink sits
// inside the row's top and bottom edges (QUIET_PY, then the small text's own leading; the
// baseline sits a little higher than the caps sit low), measured from the window.
const QUIET_PY = 1, QUIET_IN = { top: 5, bottom: 6 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// A long reply folds (Show more) when it would run past FOLD_TALL lines, to its first FOLD
// lines; LINE_H is a reply's line in px. Its words are measured as they draw, so one that
// turns out shorter than it looked isn't folded after all.
const FOLD = 20, FOLD_TALL = 28, LINE_H = 21;
// Claude Code: "No conversation found with session ID: …". Codex: "ERROR: No saved session found with ID …".
const LOST = /\bno (?:saved )?(?:conversation|session|rollout)\b.*\bfound\b|\b(?:conversation|session)\b.*\bnot found\b/i;
// What a new agent hears when its earlier session is gone (Shepherdr's words); the chat shows it
// as one quiet line (brief()).
const FRESH = "Your earlier session is gone, so this is a new one that remembers none of it. Check what is already here and preserve existing work.";
// The picker's row a typed name means (/model sonnet, /model claude-opus-5-5, /model gpt-5):
// { agent, model }, or null. `menus`: agent.js menuFor() per agent.
function findModel(menus, name) {
  const n = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
  const qs = [n(name), n(agent.modelName(name))];
  const rows = Object.entries(menus ?? {}).flatMap(([a, m]) => (m?.models ?? []).map((r) => ({ agent: a, model: r.id, keys: [n(r.id), n(r.name)] })));
  const hit = rows.find((r) => r.keys.some((k) => qs.includes(k))) ?? rows.find((r) => r.keys.some((k) => qs.some((q) => q && k.startsWith(q))));
  return hit ? { agent: hit.agent, model: hit.model } : null;
}
// About how many lines words take at a width (px), for a row's height before it's measured.
const wrapLines = (text, width) => String(text ?? "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length * 7) / Math.max(120, width))), 0);
const shellWord = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'"'"'`)}'`);
// A message's time: 14:05 today, else 3 Nov 14:05.
function clock(at) {
  if (!at) return "";
  const d = new Date(at), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}
// An edit's card (log.js diffOf()): at most this many of its lines show.
const DIFF_SHOWN = 40;
// Pictures a tool returned (log.js I records): a strip this tall, each as wide as its shape.
const GALLERY_H = 160;
const fileName = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";
const ICONS = { copy: "copy", reply: "reply", annotate: "annotate", rewind: "rewind", fork: "git-fork", react: "smile-plus" };
// Annotations as the agent reads them, ahead of the message's words: what the person points at
// (a reply, quoted; pictures, by path), each with their comment. Plain words in a herdr- tag,
// so any agent reads them and the chat shows only their count (log.js cleanUser).
function notesTag(notes) {
  if (!notes?.length) return "";
  const items = notes.map((n, i) => {
    const q = n.text.length > 2000 ? `${n.text.slice(0, 1999)}…` : n.text;
    const what = n.paths?.length ? `Picture${n.paths.length > 1 ? "s" : ""}: ${n.paths.join(", ")}${q ? ` (${q})` : ""}` : `"${q}"`;
    return `${i + 1}. ${what}${n.comment ? `\n   Their comment: ${n.comment}` : ""}`;
  });
  return `<herdr-annotations n="${notes.length}">\nThe person points at these parts of this conversation:\n${items.join("\n")}\n</herdr-annotations>\n`;
}
// Reaction pills: this wide, this far apart; and the gap before the first and after the last.
const PILL = 46, PILL_GAP = 4, PILL_EDGE = 6;
// The picker's Frequently used before there is any history.
const FREQUENT = ["👍", "👎", "❓", "✅", "👀", "🎉", "❤️", "🔥", "🙏"];
const safe = (s) => String(s).replace(/[^\w.-]/g, "_");
// A message another agent sent with hc often names its sender in its first words ("From Reviewer
// (t12u?): …"). The quiet row already says who, so its preview starts after them; the name
// stands in when the sender's address is unknown (sender()).
const SIGNED = /^\s*(?:\*\*)?(?:[Mm]essage\s+)?[Ff]rom\s+([A-Z][\w.-]*(?:\s+[\w.-]+){0,2}?)\s*(?:\([^)\n]{0,40}\))?\s*:(?:\*\*)?\s*/;
const signedBy = (text) => SIGNED.exec(String(text ?? ""))?.[1]?.trim() || null;
const unsigned = (text) => String(text ?? "").replace(SIGNED, "");

// How a card's answer went, for its quiet line ("Allowed in the chat"); null for no decision
// (the terminal asks instead).
function howAnswered(ask, text, where) {
  let d = null;
  try { d = JSON.parse(text).hookSpecificOutput?.decision; } catch {}
  if (!d) return null;
  const plan = ask.words.kind === "plan";
  if (d.behavior === "allow") return `${plan ? "Approved" : d.updatedInput ? "Answered" : "Allowed"} ${where}`;
  if (ask.words.kind === "questions") return `Left to talk over ${where}`;
  return plan ? `Sent back to planning ${where}` : `Denied ${where}`;
}
// An answer to a waiting hook (ask-hook.sh prints it as Claude's decision), the one way every
// copy of a card delivers. First how it went (the hook's end/<id>), for the ask's other copies:
// they read it once the request is gone.
async function answerAsk(dir, id, text, how) {
  if (how) await writeTextFile(`${dir}/end/${id}`, `${how}\n`, null).catch(() => {});
  await writeTextFile(`${dir}/ans/${id}.json`, text, null).catch(() => {});
}
// The person's words keep the line breaks they typed: markdown joins single lines, so each one
// becomes a hard break (outside code fences, which keep theirs).
const typed = (text) => String(text).split(/(```[\s\S]*?(?:```|$))/).map((part, i) => (i % 2 ? part : part.replace(/([^\n])\n(?!\n)/g, "$1  \n"))).join("");

// An agent message in parts: markdown, and fenced code blocks (drawn with a Copy bar).
function parts(text) {
  const out = [];
  const re = /^```([^\n`]*)\n([\s\S]*?)\n```[ \t]*$/gm;
  let at = 0, m;
  while ((m = re.exec(text))) {
    const before = text.slice(at, m.index).trim();
    if (before) out.push({ type: "md", text: before });
    out.push({ type: "code", lang: m[1].trim(), code: m[2] });
    at = m.index + m[0].length;
  }
  const rest = text.slice(at).trim();
  if (rest) out.push({ type: "md", text: rest });
  return out;
}

let bound = false;

export default class Chat extends View {
  init(_props, cx) {
    const P = props();
    this.origin = P?.terminal ?? null;
    this.addr = this.origin;
    this.machine = this.addr?.includes("/") ? this.addr.split("/")[0] : null;
    this.phase = "finding";
    this.conv = null;
    this.path = null;
    this.reset();
    // A helper's conversation (a Claude Code subagent's own log), opened from a helper row above
    // the box (openHelper()): { path, kind, title }. Read-only, following the log as it grows.
    this.transcript = P?.transcript ?? null;
    if (this.transcript) { this.path = this.transcript.path; this.kind = KINDS[this.transcript.kind] ?? "claude"; }
    this.pending = [];
    this.opened = new Set();
    this.results = new Map();
    this.pinned = true;
    this.width = 600;
    this.heights = new Map();
    // When each row's height was first measured: kept measuring a few seconds after (measurer).
    this.measuredAt = new Map();
    this.heightsFor = 0;
    // Bumped whenever the heights are forgotten: the measuring boxes get new ids with it, so
    // each reports its size again. A box that kept its id reports only a change, and a row
    // whose height came out the same at the new width then stayed on its guess (squeezed).
    this.measureGen = 0;
    this.range = null;
    this.scroll = VirtualListScrollHandle.new();
    // Its placeholder is drawn by composer(): it changes while a card asks ("Reply instead…").
    this.box = TextareaState.new({ placeholder: "" });
    this.box.set_rows(1);
    // Ctrl+Enter (the textarea's secondary submit): held until the agent is free.
    this.box.on("submit", (e, cx) => { if (!e?.shift) this.enter(cx, Boolean(e?.secondary)); });
    this.box.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.box.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.box.on("change", (_e, cx) => {
      // A big paste (over 8 KB or 200 lines) becomes a text file to send, not text in the box.
      const was = this.lastValue ?? "", now = this.box.value();
      this.lastValue = now;
      if (now.length - was.length > 8192 || now.split("\n").length - was.split("\n").length > 200) {
        let a = 0;
        while (a < was.length && was[a] === now[a]) a++;
        let b = 0;
        while (b < was.length - a && was[was.length - 1 - b] === now[now.length - 1 - b]) b++;
        const pasted = now.slice(a, now.length - b);
        const rest = was.slice(0, a) + was.slice(was.length - b);
        this.box.set_value(rest);
        this.lastValue = rest;
        cx.spawn(async (cx) => { const f = await attach.textFile(pasted); if (f) { this.addFiles([f]); this.saveSoon(cx); cx.notify(); } });
        return;
      }
      // Copied files pasted as text (file:// lines) become attachments.
      const v = this.box.value();
      if (/^file:\/\/\S/m.test(v)) {
        const found = v.split("\n").filter((l) => /^file:\/\/\S+$/.test(l.trim())).map((l) => decodeURIComponent(l.trim().slice(7)));
        this.addFiles(attach.paths(found));
        this.box.set_value(v.split("\n").filter((l) => !/^file:\/\/\S+$/.test(l.trim())).join("\n"));
      }
      this.slashSel = 0;
      // Editing a recalled message makes it a new one: arrows move in it again.
      if (this.recall >= 0 && this.box.value() !== this.recalled) this.recall = -1;
      this.sizeBox();
      this.saveSoon(cx);
      cx.notify();
    });
    // A paste with no text: the clipboard's image or copied files become attachments.
    this.box.on("paste_other", (_e, cx) => cx.spawn(async (cx) => {
      const got = await attach.fromClipboard().catch(() => []);
      if (got.length) { this.addFiles(got); this.saveSoon(cx); cx.notify(); }
    }));
    this.wasFocused = false;
    // Up/Down/Tab/Escape reach the textarea first, which keeps them. While the "/" list shows
    // (chat_slash) or the box is empty or showing a recalled message (chat_recall), these
    // bindings turn them into this chat's own actions instead (on_action in composer()).
    if (!bound) {
      bound = true;
      const keys = [];
      for (const ctx of ["Input", "TextArea", "Textarea"]) {
        keys.push({ keystroke: "up", action: "chat_slash_up", context: `chat_slash > ${ctx}` },
          { keystroke: "down", action: "chat_slash_down", context: `chat_slash > ${ctx}` },
          { keystroke: "tab", action: "chat_slash_take", context: `chat_slash > ${ctx}` },
          { keystroke: "escape", action: "chat_slash_close", context: `chat_slash > ${ctx}` },
          { keystroke: "escape", action: "chat_stop", context: `chat_stop > ${ctx}` },
          { keystroke: "escape", action: "chat_find_close", context: `chat_find > ${ctx}` },
          { keystroke: "enter", action: "chat_find_next", context: `chat_find > ${ctx}` },
          { keystroke: "shift-enter", action: "chat_find_prev", context: `chat_find > ${ctx}` },
          { keystroke: "up", action: "chat_recall_up", context: `chat_recall > ${ctx}` },
          { keystroke: "down", action: "chat_recall_down", context: `chat_recall > ${ctx}` });
      }
      try { cx.bind_keys(keys); } catch {}
    }
    // Asks from Claude's PermissionRequest hook (ask-hook.sh), oldest first: { id, req, words }.
    this.asks = [];
    // Asks that closed, each a quiet line in the conversation saying how ("Answered in the
    // terminal"): { id, title, how, at }. Kept per agent across reloads.
    this.askEnds = [];
    // The box's extras: files to send, a quoted message, messages held until the agent is free.
    this.files = [];
    this.quote = null;
    // Annotations waiting in the box ("Ask about this"): { of, text, paths, comment: InputState }.
    this.notes = [];
    this.queue = [];
    this.recall = -1;
    this.slashSel = 0;
    this.slashOff = null;
    this.cmds = [];
    this.copied = null;
    this.note = null;
    this.dflt = null;
    this.argv = null;
    this.press = null;
    this.views = {};
    this.myReacts = new Map();
    // Words written in the box while a card asked, which answered it: shown as the person's,
    // after the conversation item that was last when they went ({ id, text, after }).
    this.replied = [];
    // Question cards: their state per ask, and the keyboard for their arrows and digits.
    this.cards = new AskCards({
      reply: (ask, text, cx) => this.reply(ask, text, cx),
      toTerminal: () => this.toTerminal(),
      chatAbout: () => this.box.focus(),
    }, cx.focus_handle());
    // Cards' controls by id: their drawn widths, for which one a press was on (strips.js hit()).
    this.cardW = new Map();
    // This agent's CLI start screens (screens.js). A press on its way, and why one didn't go, by
    // card.
    this.screens = new ScreenWatch((card) => this.screenAlert(card));
    this.screenBusy = new Set();
    this.screenErr = new Map();
    // Agents whose lost session this chat already started again (lostSession()).
    this.lostTried = new Set();
    // Long replies opened with Show more (by message id), and their words' drawn height.
    this.unfolded = new Set();
    this.natural = new Map();
    // Find in the chat (Ctrl+F): open, the current match.
    this.finding = false;
    this.findIdx = 0;
    this.findBox = InputState.new({ placeholder: "Find in chat" });
    this.findBox.on("change", (_e, cx) => { this.findIdx = 0; this.findJump = true; cx.notify(); });
    // "Show thinking" is gone: so is its stored setting.
    if (shared("chat.showThinking") != null) cx.timer.after(0, () => setShared("chat.showThinking", null));
    this.uses = {};
    cx.spawn(async (cx) => {
      try { this.uses = JSON.parse(await fs.readFile(`${appHome()}/data/chat-emoji-uses.json`, "utf8")) ?? {}; } catch {}
      cx.notify();
    });
    this.viewAsked = new Set();
    this.restartReqAt = shared("chat.restartreq")?.at ?? null;
    this.reactReqAt = shared("chat.reactreq")?.at ?? null;
    this.sendReqAt = shared("chat.sendreq")?.at ?? null;
    // The working line's clock, once a second while the agent works.
    cx.timer.every(1000, (cx) => { if (this.status() === "working") cx.notify(); });
    // Drafts belong to the agent's first address (its origin), so they survive Chat ⇄ Terminal,
    // restarts from here, and app restarts.
    const labels = terminals().find((x) => x.address === this.addr)?.labels ?? {};
    this.originKey = labels["herdr.chat.origin"] || this.addr || "none";
    this.draftFile = `${appHome()}/data/chat-drafts/${safe(this.originKey)}.json`;
    if (this.addr) cx.spawn(async (cx) => { await this.loadDraft(cx); attach.prune(); });
    if (this.addr || this.transcript) cx.spawn(async (cx) => this.follow(cx));
    // The list drew nothing while it has rows (scrolled past its end, a height gone wrong):
    // forget the heights and go to the newest again. Checked rarely; redraws only then.
    cx.timer.every(1500, (cx) => {
      if (!this.blank) return;
      this.blank = false;
      this.heights.clear(); this.measuredAt.clear(); this.measureGen++;
      this.anchor = null; this.pinned = true; this.stick = true;
      cx.notify();
    });
    if (this.addr && !this.machine) cx.spawn(async (cx) => this.watchAsks(cx));
    // Keys (keys.json "mod:chat") for this chat.
    // At most 5 s per wait (one pending nextCommand), so a reload's old build ends at its next
    // cx use instead of staying in memory.
    cx.spawn(async (cx) => {
      let cmd = null;
      for (;;) {
        cmd ??= nextCommand();
        const c = await Promise.race([cmd, cx.sleep(5000)]);
        if (c === undefined) continue;
        cmd = null;
        // From the shell: data/chat-sendreq.json = { pane, text, files? }, then `herdr-app do
        // chat.send` (with fill: true, the words go into the box instead; with peek: true, the
        // agent's terminal shows).
        if (c === "send") {
          const f = `${appHome()}/data/chat-sendreq.json`;
          let req = null;
          try { req = JSON.parse(await fs.readFile(f, "utf8")); } catch {}
          const me = this.myPane();
          if (req?.pane && req.pane === me && req.peek) {
            await fs.unlink(f).catch(() => {});
            this.toTerminal();
          } else if (req?.pane && req.pane === me && req.fill) {
            await fs.unlink(f).catch(() => {});
            const v = String(req.text ?? "");
            this.box.set_value(v);
            this.box.set_selected_range({ start: v.length, end: v.length });
            this.box.focus();
            cx.notify();
          } else if (req?.pane && req.pane === me && String(req.text ?? "").trim()) {
            await fs.unlink(f).catch(() => {});
            // files: paths to go with it, as a drop gives them.
            const files = attach.paths(Array.isArray(req.files) ? req.files.map(String) : []);
            this.deliver({ id: `m${Date.now()}`, text: String(req.text).trim(), files, quote: null }, cx);
            this.pinned = true;
            this.stick = true;
            cx.notify();
          }
          continue;
        }
        if (focused()?.pane !== this.myPane()) continue;
        if (c === "find") this.openFind(cx);
        cx.notify();
      }
    });
  }

  // Forget what was read: another log file, or this one replaced.
  reset() {
    this.records = [];
    this.start = null;
    this.end = 0;
    this.conv = null;
    this.anchor = null;
    this.loadingEarlier = false;
  }

  // Closing (back to the terminal, or the pane goes): the hook stops waiting on this chat, so
  // Claude asks in its terminal instead.
  async close(cx) {
    this.box.release();
    this.findBox.release();
    this.scroll.release();
    if (!this.addr || this.machine) return;
    await exec("sh", ["-c", 'rm -f "$1/open/$2"; for f in "$1/req/$2".*.json; do [ -f "$f" ] && : > "$1/ans/${f##*/}"; done; true', "x", this.askDir, this.addr]);
  }

  // ---- drafts -----------------------------------------------------------------------------

  async loadDraft(cx) {
    const text = await fs.readFile(this.draftFile, "utf8").catch(() => null);
    let d = null;
    try { d = JSON.parse(text ?? "null"); } catch {}
    if (!d) return;
    if (d.text && !this.box.value()) this.box.set_value(d.text);
    this.files = Array.isArray(d.files) ? d.files : [];
    this.quote = d.quote ?? null;
    this.queue = Array.isArray(d.queue) ? d.queue : [];
    cx.notify();
  }

  saveSoon(cx) {
    this.saveAt = Date.now();
    cx.timer.after(400, (cx) => { if (Date.now() - this.saveAt >= 380) cx.spawn(async () => this.saveDraft()); });
  }

  async saveDraft() {
    const d = { text: this.box.value(), files: this.files, quote: this.quote, queue: this.queue };
    const empty = !d.text.trim() && !d.files.length && !d.quote && !d.queue.length;
    try {
      if (empty) { if (await fs.exists(this.draftFile)) await fs.unlink(this.draftFile); return; }
      await fs.mkdir(`${appHome()}/data/chat-drafts`, { recursive: true });
      await fs.writeFile(this.draftFile, JSON.stringify(d));
    } catch {}
  }

  // Where files are sent (attach.deliver): a sandboxed agent gets copies of files from outside
  // its folder, which it couldn't read.
  deliverTo() {
    const t = terminals().find((x) => x.address === this.addr);
    return { sandbox: Boolean(t?.labels?.["herdr.sandbox"]), folder: t?.foreground?.cwd ?? t?.cwd ?? null };
  }

  addFiles(list) {
    for (const f of list) if (!this.files.some((x) => x.path === f.path)) this.files.push(f);
    this.files = this.files.slice(0, 20);
  }

  // ---- Claude's permission asks -------------------------------------------------------------

  // Where the hook leaves this agent's asks. A sandboxed agent can write only its own broker
  // spool (sandbox/agent-sandbox), so its hook uses that, and no agent answers another's prompt.
  get askDir() {
    const box = terminals().find((x) => x.address === this.addr)?.labels?.["herdr.sandbox"];
    return box ? `${appHome()}/sandbox/broker/${box}/chat-asks` : `${appHome()}/data/chat-asks`;
  }

  // The hook's flag: this chat is showing. Touched every few seconds; stale after 15. From the
  // moment the chat knows its agent (not only once its conversation shows): an agent started
  // from here may ask in its first seconds, and without the flag the hook leaves it to the CLI.
  async flag() {
    if (this.machine || !this.addr || this.phase === "ended") return;
    await exec("sh", ["-c", 'mkdir -p "$1/open" "$1/req" "$1/ans" && touch "$1/open/$2"', "x", this.askDir, this.addr]);
  }

  async watchAsks(cx) {
    await exec("sh", ["-c", 'mkdir -p "$1/open" "$1/req" "$1/ans"', "x", this.askDir]).catch(() => {});
    for (;;) {
      await this.readAsks(cx);
      // One watch at a time, as for the log.
      this.askWatch ??= watchFolder(`${this.askDir}/req`).finally(() => { this.askWatch = null; });
      await Promise.race([this.askWatch, cx.sleep(5000)]);
    }
  }

  async readAsks(cx) {
    // Each request is named <terminal>.<time>.<hook pid>: one whose hook was killed (Claude or
    // Codex stopped it) is gone, so drop its file.
    const r = await exec("sh", ["-c", 'cd "$1/req" 2>/dev/null || exit 0; for f in "$2".*.json; do [ -f "$f" ] || continue; p=${f%.json}; p=${p##*.}; if kill -0 "$p" 2>/dev/null; then echo "$f"; else rm -f "$f"; fi; done; true', "x", this.askDir, this.addr]);
    const ids = r.stdout.split("\n").filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    const kept = this.asks.filter((a) => ids.includes(a.id));
    // Gone without an answer from here: the hook says how (data/chat-asks/end/<id>: answered
    // or declined in the terminal, the agent stopped), else Claude stopped waiting on it.
    for (const a of this.asks.filter((a) => !ids.includes(a.id))) {
      const how = (await readTextFile(`${this.askDir}/end/${a.id}`).catch(() => null))?.trim();
      this.askEnded(a, how || "No longer waiting");
    }
    let added = false;
    for (const id of ids) {
      if (kept.some((a) => a.id === id)) continue;
      const text = await readTextFile(`${this.askDir}/req/${id}.json`).catch(() => null);
      let req = null;
      try { req = JSON.parse(text ?? ""); } catch {}
      // Unreadable here: it can only be allowed in the terminal.
      const w = req ? words(req) : { kind: "permission", title: "Claude asks for something the chat can't read", detail: "", unread: true };
      kept.push({ id, req, words: w });
      added = true;
    }
    if (added || kept.length !== this.asks.length) {
      this.asks = kept;
      this.cards.keep(kept.map((a) => a.id));
      if (added) this.askAlert();
      cx.notify();
    }
  }

  // A new ask: the agent waits on the person, as when it's blocked.
  askAlert() {
    const mine = this.myPane();
    const looking = Boolean(mine) && focused()?.pane === mine && window()?.active;
    const k = terminals().find((x) => x.address === this.addr);
    if (settings()?.sounds?.enabled !== false) playSound("blocked");
    if (looking) return;
    const tab = mine && panes().find((p) => p.pane === mine)?.tab;
    toast({ title: `${toastWho(k)} · Needs you`, body: this.asks[0]?.words.title ?? "", level: "alert",
      action: tab ? { name: "tab.select", args: { id: tab } } : undefined });
  }

  // An ask closed: its quiet line. Questions have theirs from the log already (log.js "ask").
  askEnded(ask, how) {
    this.loadAskEnds();
    if (ask.words.kind === "questions" || this.askEnds.some((e) => e.id === ask.id)) return;
    this.askEnds = [...this.askEnds, { id: ask.id, title: ask.words.title, how, at: askAt(ask.id) }].slice(-20);
    try { localStorage.setItem(`askends:${this.addr}`, JSON.stringify(this.askEnds)); } catch {}
  }

  // This agent's closed asks, from before a reload.
  loadAskEnds() {
    if (this.askEndsOf === this.addr) return;
    this.askEndsOf = this.addr;
    try { this.askEnds = JSON.parse(localStorage.getItem(`askends:${this.addr}`) ?? "[]") ?? []; } catch { this.askEnds = []; }
  }

  // The card's answer goes to the waiting hook; it prints it as Claude's decision.
  reply(ask, text, cx) {
    this.asks = this.asks.filter((a) => a !== ask);
    const how = howAnswered(ask, text, "in the chat");
    if (how) this.askEnded(ask, how);
    cx.notify();
    cx.spawn(async () => answerAsk(this.askDir, ask.id, text, how));
  }

  // The cards waiting in this chat, each with its moment: an ask, or the agent's start screen.
  // Each: { id, at, strips, owner (its AskCards, for keys), ask, question (a questions card) }.
  timelineCards() {
    const out = [];
    for (const a of this.asks) out.push({ id: `card:${a.id}`, at: askAt(a.id), strips: this.cards.strips(a, { who: this.cli() }), owner: this.cards, ask: a, question: a.words.kind === "questions" });
    const own = this.addr && openCard(this.addr);
    if (own) out.push({ id: `card:${own.id}`, at: own.opened, strips: screenStrips(own, { who: this.cli(),
      busy: this.screenBusy.has(own.id), error: this.screenErr.get(own.id),
      press: (i, cx) => this.pressScreen(own, i, cx), toTerminal: () => this.toTerminal() }) });
    return out;
  }

  // The agent's status. Parked behind this chat it isn't in agents(); the core's word then.
  status() {
    const a = agents().find((x) => x.address === this.addr);
    if (a) return a.status;
    const k = terminals().find((x) => x.address === this.addr);
    return ["working", "blocked", "done", "idle"].includes(k?.status) ? k.status : null;
  }

  // This chat's agent: hc get's record (locate()) with the live status and turn.
  ownTerminal() {
    const live = terminals().find((x) => x.address === this.addr);
    if (!this.t || this.t.address !== this.addr) return live ?? null;
    return live ? { ...this.t, status: live.status, turn: live.turn, state: live.state } : this.t;
  }

  log(args) {
    return exec("sh", ["-c", this.transcript ? `SIDE=1\n${LOG}` : LOG, "log", ...args], { on: this.machine });
  }

  // ---- start screens and lost sessions ------------------------------------------------------

  // A new start-screen card: the agent waits on the person, as when it asks.
  screenAlert(card) {
    const k = terminals().find((x) => x.address === card.addr);
    if (settings()?.sounds?.enabled !== false) playSound("blocked");
    const mine = this.myPane();
    if (Boolean(mine) && focused()?.pane === mine && window()?.active) return;
    const tab = mine && panes().find((p) => p.pane === mine)?.tab;
    toast({ title: `${toastWho(k)} · Needs you`, body: `${card.cli} is waiting on its start screen.`, level: "alert",
      action: tab ? { name: "tab.select", args: { id: tab } } : undefined });
  }

  // A press on a start screen's choice.
  pressScreen(card, i, cx) {
    if (this.screenBusy.has(card.id)) return;
    this.screenBusy.add(card.id);
    this.screenErr.delete(card.id);
    cx.notify();
    cx.spawn(async (cx) => {
      const err = await this.screens.press(card, i).catch((e) => String(e?.message ?? e));
      this.screenBusy.delete(card.id);
      if (err) this.screenErr.set(card.id, err);
      cx.notify();
    });
  }

  // Did the agent at `addr` stop because the session it resumed is gone ("No conversation
  // found")? Then a new one starts by itself. Looked at once per agent.
  async checkLost(addr, cx, t = null) {
    if (this.lostTried.has(addr)) return false;
    this.lostTried.add(addr);
    if (!t) { try { t = JSON.parse((await hc(["get", addr, "--json"])).stdout || "null"); } catch {} }
    const kind = cliOf({ agent: (t?.argv ?? []).map((a) => String(a).split("/").pop()).find((a) => /^(claude|codex)$/.test(a)) });
    const fresh = kind ? agent.freshArgv(kind, t?.argv) : null;
    if (!fresh) return false;
    if (t.state !== "live" && (t.exit_code ?? 1) === 0) return false;
    const screen = (await hc(["read", addr, "--lines", "40"]).catch(() => null))?.stdout ?? "";
    if (!LOST.test(screen.split("\n").slice(-30).join("\n"))) return false;
    // One start for it, whichever copy of its chat saw it first: shared "chat.lost" = { [address]:
    // when }.
    const lost = shared("chat.lost") ?? {};
    if (Date.now() - (lost[addr] ?? 0) < 120000) return true;
    setShared("chat.lost", { ...Object.fromEntries(Object.entries(lost).filter(([, at]) => Date.now() - at < 120000)), [addr]: Date.now() });
    await this.lostSession(t, kind, fresh, cx);
    return true;
  }

  // The session is gone, so a new one starts in the same chat with a short handover, and the
  // chat says so in one quiet line (brief()). An agent still at its shell gets the new agent
  // typed into that shell: the same terminal and labels. One whose terminal ended starts again
  // the way the model picker restarts (agent.js).
  async lostSession(t, kind, fresh, cx) {
    const msg = `<restart>${FRESH}</restart>`;
    this.note = { id: `note-${Date.now()}`, text: "Earlier session was gone, starting a new one…" };
    cx.notify();
    try {
      if (t.state === "live") {
        // hc send pastes the line into the shell and presses Enter.
        const r = await hc(["send", t.address, [...fresh, msg].map(shellWord).join(" ")]);
        if (r.code !== 0) throw new Error(refusal(r).message);
      } else {
        const pane = this.myPane();
        if (!pane) return;
        this.swapping = true;
        const next = await agent.restart(t, { argv: [...fresh, msg], resume: true }, pane);
        this.follow_to(next);
      }
      this.note = { id: `note-${Date.now()}`, text: "Earlier session was gone, started a new one." };
    } catch (e) {
      this.note = { id: `note-${Date.now()}`, text: `Earlier session was gone, and a new one didn't start: ${String(e?.message ?? e)}` };
    } finally {
      this.swapping = false;
    }
    cx.timer.after(8000, (cx) => { this.note = null; cx.notify(); });
    cx.notify();
  }

  // ---- following the log --------------------------------------------------------------------

  // The agent's process and its log, again every few seconds: a /clear, a resume or a new
  // agent started in the same terminal writes another file.
  async locate(cx) {
    if (this.swapping || this.transcript) return;
    const r = await hc(["get", this.addr, "--json"]);
    let t = null;
    try { t = JSON.parse(r.stdout || "null"); } catch {}
    // Gone for good (removed after a restart from here), or unreachable for now (another
    // machine offline: try again later, don't call it ended).
    const gone = /not_found|no terminal/.test(`${r.stdout}\n${r.stderr}`);
    if (!gone && (!t || t.error)) return;
    if (gone || t?.state !== "live") {
      // Restarted from here (perhaps before Herdr restarted): the new agent carries the origin.
      const next = terminals().find((x) => x.state === "live" && x.address !== this.addr && x.labels?.["herdr.chat.origin"] === this.originKey);
      if (next) { this.follow_to(next.address); return; }
      // It ended because the session it resumed is gone: a new one starts by itself.
      if (!gone && t && await this.checkLost(this.addr, cx, t)) return;
      this.set("ended", cx);
      return;
    }
    // Parked behind this chat, the terminal lost core keep (terminal.park turns it off): turn it
    // back on, so the agent survives a lost core like any pane's terminal.
    if (t.keep === false && !t.labels?.["herdr.tab"] && !panes().some((p) => p.terminal === this.addr)) await hc(["keep", this.addr]);
    // The agent lost its link to this chat (herdr.chat) while it has no pane of its own: link it
    // again, or the header, the agents list and the sweep take it for an agent without a chat.
    // Only to the pane this chat last knew as its own, while that is still a chat pane.
    const pane = this.lastPane ?? null;
    if (!this.swapping && !t.labels?.["herdr.chat"] && pane && !panes().some((p) => p.terminal === this.addr)
      && panes().some((p) => p.pane === pane && p.mod === "chat")) await hc(["label", this.addr, `herdr.chat=${pane}`]);
    const kind = KINDS[t.status?.app] ?? KINDS[t.foreground?.name];
    // Back at its shell because the session it resumed is gone: a new agent starts there.
    if (!kind) { if (!(await this.checkLost(this.addr, cx, t))) this.set("unsupported", cx); return; }
    // Herdr names the CLI a moment after it starts (behind agent-sandbox, its process is bash
    // first): one taken for unsupported then is found now.
    if (this.phase === "unsupported") this.phase = "finding";
    this.t = t;
    this.argv = agent.own(t.foreground?.argv ?? t.argv ?? null);
    const pid = t.foreground?.pid;
    if (!pid) { if (this.phase !== "ready") this.set("none", cx); return; }
    // What the agent's own settings say (model, effort, speed), once per process.
    if (this.dfltFor !== `${kind}|${pid}`) {
      this.dfltFor = `${kind}|${pid}`;
      cx.spawn(async (cx) => { this.dflt = await agent.defaults(kind, this.machine); cx.notify(); });
      cx.spawn(async (cx) => { this.cmds = await slash.commands(kind, this.machine, t.foreground?.cwd ?? t.cwd); cx.notify(); });
    }
    const f = await exec("sh", ["-c", FIND, "chat", kind, String(pid)], { on: this.machine });
    let path = f.stdout.trim().split("\n").pop() ?? "";
    // Not in its session yet (no report, no turn): perhaps on its own start screen, which
    // shows as a card under an empty chat.
    if (!path && starting(t)) path = "pending";
    if (path === "pending") {
      // A Claude Code that hasn't written its first line yet has no file: an empty chat.
      if (this.phase === "finding") { this.kind = kind; this.conv = new Conversation(kind, { side: Boolean(this.transcript) }); this.start = 0; this.set("ready", cx); }
      return;
    }
    if (!path) { if (this.phase !== "ready") this.set("none", cx); return; }
    if (path !== this.path || kind !== this.kind) {
      this.path = path;
      this.kind = kind;
      this.reset();
      this.pinned = true;
    }
  }

  // Shows another terminal from now on (the agent was restarted).
  follow_to(addr) {
    this.addr = addr;
    this.flag();
    // The box comes back once the new agent's conversation shows: give it the keyboard again.
    this.wasFocused = false;
    this.machine = addr.includes("/") ? addr.split("/")[0] : null;
    this.path = null;
    this.dfltFor = null;
    this.reset();
    this.phase = "finding";
  }

  set(phase, cx) {
    if (this.phase === phase) return;
    this.phase = phase;
    cx.notify();
  }

  rebuild() {
    this.conv = new Conversation(this.kind, { side: Boolean(this.transcript) });
    this.conv.feed(this.records);
    // A log read from its start (a new agent's first message makes it) may already hold
    // messages sent from here.
    this.settlePending();
  }

  // A message sent from here is in once the log has it (its typed words, at least: an image
  // path becomes an image, a quote stays in front).
  settlePending() {
    if (!this.conv) return;
    const users = this.conv.items.filter((x) => x.kind === "user");
    // An answer written in the box is in once the log has it as an answer.
    if (this.replied?.length) this.replied = this.replied.filter((r) => !users.some((u) => u.answer && (u.at ?? 0) >= r.at - 5000 && norm(u.text).includes(norm(r.text))));
    if (!this.pending?.length) return;
    this.pending = this.pending.filter((p) => !users.some((u) => (u.at ?? 0) >= p.at - 5000 &&
      (same(u.text, p.sent) || (p.match && norm(u.text).includes(p.match)) || (!p.match && (u.images || u.notes)))));
  }

  // The newest page first; after that, what the log gained since.
  async pull(cx) {
    if (!this.path) return;
    const path = this.path;
    if (this.start === null) {
      const r = await this.log(["page", path, "999999999999999", String(PAGE)]);
      if (path !== this.path) return;
      if (r.stdout.startsWith("missing")) { this.path = null; return; }
      const { head, records: recs } = records(r.stdout);
      if (head[0] !== "P") return;
      this.start = Number(head[1]);
      this.end = Number(head[2]);
      this.records = recs;
      this.rebuild();
      this.stick = true;
      this.phase = "ready";
      cx.notify();
      return;
    }
    const r = await this.log(["tail", path, String(this.end)]);
    if (path !== this.path) return;
    if (r.stdout.startsWith("missing")) { this.path = null; return; }
    const { head, records: recs } = records(r.stdout);
    if (head[0] !== "T") return;
    // Shorter than what was read: the file was replaced. Start over from its end.
    if (Number(head[2]) < this.end) { this.reset(); return; }
    this.end = Number(head[3]);
    if (!recs.length) return;
    this.records.push(...recs);
    if (this.records.length > KEEP && !this.loadingEarlier) {
      // Down to three quarters, so the rebuild is now and then, not on every message.
      this.records = this.records.slice(-Math.floor(KEEP * 0.75));
      this.start = this.records[0].off;
      this.rebuild();
    } else this.conv.feed(recs);
    // Your reactions just sent stay shown as sent until the log says the same.
    for (const [id, mine] of this.myReacts) {
      const logged = this.conv.reactions.get(id) ?? [];
      for (const [emoji, on] of mine) if (logged.some((r) => r.by === "you" && r.emoji === emoji) === on) mine.delete(emoji);
      if (!mine.size) this.myReacts.delete(id);
    }
    this.settlePending();
    this.stick = true;
    cx.notify();
  }

  // The page before what is shown, when the person reaches the top. The row that was first
  // stays where it was: the list is scrolled back to it once the new rows are in.
  loadEarlier(cx) {
    if (this.loadingEarlier || !this.start || !this.path) return;
    this.loadingEarlier = true;
    const path = this.path, before = this.start;
    const rows = this.rows();
    const first = rows[Math.min(rows.length - 1, Math.max(1, this.range?.start ?? 1))]?.id;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await this.log(["page", path, String(before), String(PAGE)]);
        const { head, records: recs } = records(r.stdout);
        if (path !== this.path || this.start !== before || head[0] !== "P") return;
        this.start = Number(head[1]);
        this.records = [...recs, ...this.records];
        this.rebuild();
        this.anchor = first ? { id: first, until: Date.now() + 3000 } : null;
        this.reanchor = true;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loadingEarlier = false;
        cx.notify();
      }
    });
  }

  // An opened tools row shows each call's output, read from the log only now.
  loadResults(row, cx) {
    const want = row.steps.filter((s) => s.out !== undefined && !this.results.has(s.id));
    if (!want.length || !this.path) return;
    for (const s of want) this.results.set(s.id, null);
    for (const k of this.results.keys()) { if (this.results.size <= KEEP) break; this.results.delete(k); }
    const offs = [...new Set(want.map((s) => s.out))].slice(0, 40);
    const path = this.path;
    cx.spawn(async (cx) => {
      try {
        const r = await this.log(["results", path, ...offs.map(String)]);
        for (const part of r.stdout.split("\x1e").slice(1)) {
          const nl = part.indexOf("\n");
          const off = Number(part.slice(0, nl));
          const line = part.slice(nl + 1).replace(/\n$/, "");
          for (const s of want) if (s.out === off) this.results.set(s.id, resultText(line, s.id) ?? "");
        }
      } catch {}
      cx.notify();
    });
  }

  async follow(cx) {
    let last = 0;
    for (;;) {
      try {
        if (!this.path || Date.now() - last > 4000) { last = Date.now(); await this.locate(cx); }
        if (this.phase === "ended" && !this.swapping) {
          this.closeSelf();
          return;
        }
        await this.pull(cx);
        await this.flag();
        // Its own start screen, while it has no session (or a card is still open).
        const k = this.ownTerminal();
        if (k && (starting(k) || openCard(this.addr))) { await this.screens.tick(this.addr, k); cx.notify(); }
        this.alerts(cx);
        this.drainQueue(cx);
        this.publishHelpers();
        // Dragged to the top with the scrollbar: no wheel said so.
        if (this.start && (this.range?.start ?? 9) <= 1) this.loadEarlier(cx);
        if (this.error) { this.error = null; cx.notify(); }
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
      const working = this.status() === "working" || this.pending.length > 0 || starting(this.ownTerminal());
      if (!this.machine && this.path) {
        // Here: wake on the log's folder changing, and look again now and then anyway.
        const dir = this.path.slice(0, this.path.lastIndexOf("/"));
        // One watch at a time: the folder may stay quiet for hours.
        if (this.watching?.dir !== dir) this.watching = { dir, next: watchFolder(dir).finally(() => { this.watching = null; }) };
        await Promise.race([this.watching.next, cx.sleep(4000)]);
      } else {
        await cx.sleep(working ? 1500 : 4000);
      }
    }
  }

  // ---- sending ------------------------------------------------------------------------------

  // Enter: now (while the agent works, it takes it mid-turn). Ctrl+Enter while it
  // works: held, and sent by itself once it is free.
  send(cx, hold = false) {
    const text = this.box.value().trim();
    // Also while the agent asks in its terminal: the words answer it there (deliver()).
    if (!text && !this.files.length && !this.notes.length) return;
    const msg = { id: `m${Date.now()}`, text, files: this.files, quote: this.quote,
      notes: this.notes.map((n) => ({ text: n.quote.value().trim(), paths: n.paths, comment: n.comment.value().trim() })) };
    this.notes = [];
    this.box.set_value("");
    // If the textarea still adds Enter's new line after this, take it out again.
    cx.timer.after(30, () => { if (!this.box.value().trim()) this.box.set_value(""); });
    this.files = [];
    this.quote = null;
    this.recall = -1;
    // /model (with or without a name) never reaches the CLI, which would keep it as the default
    // for every later agent: it opens the model picker instead, that model chosen.
    const mm = !msg.files.length && /^\/model(?:\s+(\S+))?\s*$/i.exec(text);
    if (mm) { this.quote = msg.quote; this.modelCommand(mm[1] ?? null, cx); this.saveSoon(cx); cx.notify(); return; }
    if (hold && this.status() === "working") this.queue.push(msg);
    else this.deliver(msg, cx);
    this.saveSoon(cx);
    this.pinned = true;
    this.stick = true;
    cx.notify();
  }

  // Enter (the textarea's submit and the key both say so; once is enough): takes the chosen
  // "/" command while the list shows, else sends (held with Ctrl).
  enter(cx, hold) {
    if (Date.now() - (this.enterAt ?? 0) < 120) return;
    this.enterAt = Date.now();
    const list = this.suggestions();
    if (list.length) {
      const c = list[Math.min(this.slashSel, list.length - 1)];
      if (this.box.value().trim() !== c.insert.trim()) { this.pick(c, cx); cx.timer.after(30, () => this.box.set_value(c.insert)); return; }
    }
    this.send(cx, hold);
  }

  // A held message goes once the agent stops working (and isn't asking something).
  drainQueue(cx) {
    if (!this.queue.length || this.phase !== "ready") return;
    const st = this.status();
    if (st === "working" || st === "blocked" || this.asks.length || openCard(this.addr) || this.pending.some((p) => !p.failed && !p.late)) return;
    const msg = this.queue.shift();
    if (msg.raw) hc(["send", this.addr, msg.text]);
    else this.deliver(msg, cx);
    this.saveSoon(cx);
    cx.notify();
  }

  deliver(msg, cx) {
    // /model never reaches the CLI by any way in (held, or sent by another mod): send() says why.
    const mm = !msg.files?.length && /^\/model(?:\s+(\S+))?\s*$/i.exec(msg.text ?? "");
    if (mm) { this.modelCommand(mm[1] ?? null, cx); return; }
    // The CLI shows its own start screen (a card here): typed words could pick one of its
    // choices, so they wait until it is answered (drainQueue()).
    if (openCard(this.addr)) { this.queue.push(msg); return; }
    // A card asks (a question, a permission, a plan): the words answer it, as typing in the
    // CLI would (cards.js replyWith); the card's buttons still work too.
    if (this.asks.length && msg.text && !msg.files?.length) {
      this.replied = [...this.replied.slice(-20), { id: msg.id, text: msg.text, at: Date.now() }];
      this.cards.replyWith(this.asks[0], msg.text, cx);
      return;
    }
    // A Herdr tag line before the words: the message it replies to.
    const reply = msg.quote ? `<hc reply-to="${excerpt(msg.quote.text, 80)}"/>\n` : "";
    const body = reply + notesTag(msg.notes) + msg.text;
    const p = { id: `pending-${msg.id}`, text: msg.text, replyTo: msg.quote ? excerpt(msg.quote.text, 80) : null, files: msg.files.filter((f) => !f.image).map((f) => f.name),
      notes: msg.notes?.length ?? 0, paths: msg.files.filter((f) => f.image).map((f) => f.path), at: Date.now(), sent: body,
      match: norm(msg.text).slice(0, 60) || null, msg };
    this.pending.push(p);
    const menu = msg.files.length ? null : slash.opensMenu(this.kind, msg.text);
    if (menu) this.note = { id: `note-${msg.id}`, text: `/${menu} opens a menu in the terminal. Switching to it.` };
    cx.spawn(async (cx) => {
      let r;
      try {
        const paths = await attach.deliver(msg.files, this.addr, this.machine, this.deliverTo());
        p.sent = [body, ...paths].filter(Boolean).join("\n\n");
        r = await this.typed(() => hc(["send", this.addr, p.sent]));
        // Its own dialog is open in its terminal (a question or a permission with no card
        // here): the words answer it the "Reply instead…" way.
        if (r.code !== 0 && refusal(r).kind === "blocked" && (this.kind === "claude" || this.kind === "codex")) r = await this.replyInstead(p.sent, cx);
      } catch (e) {
        r = { code: 1, stderr: String(e?.message ?? e) };
      }
      // Kept as a bubble that sends again when pressed (clickRow), so nothing is lost.
      if (r.code !== 0) { p.failed = refusal(r).message; cx.notify(); return; }
      // In the agent's terminal now: it's sent. The log has it only once taken, so it shows as
      // sent from here.
      p.delivered = true;
      cx.notify();
      // /btw: Claude Code answers a side question in an overlay of its terminal, never in the
      // conversation, mid-turn too: that terminal opens in a peek over the chat to read it.
      if (this.kind === "claude" && /^\/btw\s+\S/.test(msg.text ?? "")) {
        this.pending = this.pending.filter((x) => x !== p);
        this.note = { id: `note-${msg.id}`, text: `Side question: ${excerpt(msg.text.replace(/^\/btw\s+/, ""), 60)}. Its answer is in the panel over the chat.` };
        cx.timer.after(8000, (cx) => { this.note = null; cx.notify(); });
        await cx.sleep(300);
        run("terminal.peek", { terminal: this.addr });
        return;
      }
      // Mid-turn, Claude Code holds a typed message until its turn ends ("ctrl+enter to send
      // now"): send it now, so the agent takes it at once (it steers).
      if (this.kind === "claude") await this.steerNow(cx);
      if (menu) {
        // A command with its own menu: show it where it works, the terminal.
        await cx.sleep(900);
        this.pending = this.pending.filter((x) => x !== p);
        this.note = null;
        this.toTerminal();
        return;
      }
      // Not in the log after a while, with the agent no longer busy: say so, and keep it until it shows up.
      for (let i = 0; i < 60 && this.pending.includes(p) && !p.failed; i++) {
        await cx.sleep(i ? 5000 : 20000);
        if (this.status() !== "working") { p.late = true; cx.notify(); break; }
      }
    });
  }

  // The agent waits on its own dialog in the terminal (a question, a permission): Esc closes it
  // (Claude Code hears the person declined it; Codex stops), then the words go as a message,
  // once it takes typing again.
  async replyInstead(text, cx) {
    await hc(["keys", this.addr, "esc"]);
    let r;
    for (let i = 0; i < 10; i++) {
      await cx.sleep(300);
      r = await hc(["send", this.addr, text]);
      if (r.code === 0 || refusal(r).kind !== "blocked") break;
    }
    return r;
  }

  // A message that didn't go, pressed: it goes again.
  retry(p, cx) {
    this.pending = this.pending.filter((x) => x !== p);
    this.deliver(p.msg, cx);
  }

  // Claude Code's "send now" for a message it queued while working: Ctrl+Enter, only when its
  // screen offers it (pressed on an empty prompt it would do something else).
  async steerNow(cx) {
    for (let i = 0; i < 4; i++) {
      await cx.sleep(i ? 300 : 150);
      const r = await hc(["read", this.addr, "--lines", "40"]).catch(() => null);
      if (/ctrl\+enter to send now/i.test(r?.stdout ?? "")) { await hc(["keys", this.addr, "ctrl+enter"]); return; }
      if (this.status() !== "working") return;
    }
  }

  // A held message sent at once (the agent takes it mid-turn).
  sendQueued(msg, cx) {
    this.queue = this.queue.filter((m) => m !== msg);
    if (msg.raw) hc(["send", this.addr, msg.text]);
    else this.deliver(msg, cx);
    this.saveSoon(cx);
  }

  // Stop: the CLI's own interrupt. The working line says "Stopping…" until it is idle.
  stop(cx) {
    if (this.status() !== "working") return;
    this.stopping = true;
    hc(["interrupt", this.addr]);
    cx.notify();
  }

  // A held message back into the box, to change it before it goes.
  editQueued(msg, cx) {
    this.queue = this.queue.filter((m) => m !== msg);
    const now = this.box.value().trim();
    this.box.set_value(now ? `${msg.text}\n\n${now}` : msg.text);
    this.addFiles(msg.files);
    if (msg.quote && !this.quote) this.quote = msg.quote;
    this.box.focus();
    this.saveSoon(cx);
  }

  // Up in an empty box (or one showing a recalled message): the previous message again.
  recallStep(dir) {
    const mine = [...(this.conv?.items ?? []).filter((x) => x.kind === "user" && x.text && !x.from).map((x) => x.text), ...this.pending.map((p) => p.text)];
    const list = [...new Set(mine.reverse())];
    if (!list.length) return false;
    const next = this.recall + dir;
    if (next < -1 || next >= list.length) return true;
    this.recall = next;
    this.recalled = next < 0 ? "" : list[next];
    this.box.set_value(this.recalled);
    return true;
  }

  // ---- slash commands -----------------------------------------------------------------------

  suggestions() {
    // Enter's new line may already be in the box when the submit comes.
    const v = this.box.value().replace(/\n+$/, "");
    if (this.slashOff === v) return [];
    // "/": commands (and Claude Code's skills, which it runs as commands). "$": Codex's skills,
    // which it takes anywhere in a message.
    const w = slash.typing(v);
    if (!w || !this.cmds.length) return [];
    const codexSkill = (c) => c.skill && this.kind === "codex";
    const pool = this.cmds.filter((c) => (w.sigil === "$" ? codexSkill(c) : !codexSkill(c)));
    return slash.match(pool, w.word).map((c) => ({ ...c, label: w.sigil + c.name, state: c.skill ? "Skill" : null,
      insert: w.sigil === "$" ? v.replace(/\$[\w:.-]*$/, `$${c.name} `) : `/${c.name} ` }));
  }

  pick(c, cx) {
    this.box.set_value(c.insert);
    this.slashOff = c.insert;
    this.box.focus();
    cx.notify();
  }

  // ---- find (Ctrl+F) ----------------------------------------------------------------------------

  openFind(cx) {
    this.finding = true;
    this.findJump = true;
    cx.timer.after(0, () => this.findBox.focus());
    cx.notify();
  }

  closeFind(cx) {
    this.finding = false;
    this.box.focus();
    cx.notify();
  }

  findQuery() {
    return this.finding ? this.findBox.value().trim() : "";
  }

  // Every match in the loaded conversation: [{ index (row), id, n (matches in it) }].
  findMatches(rows) {
    const q = this.findQuery().toLowerCase();
    if (!q) return [];
    const out = [];
    rows.forEach((r, index) => {
      const text = (["user", "agent", "pending", "brief"].includes(r.kind) ? r.text : r.kind === "code" ? r.code : null) ?? "";
      let n = 0, at = 0;
      const low = text.toLowerCase();
      while ((at = low.indexOf(q, at)) >= 0) { n++; at += q.length; }
      if (n) out.push({ index, id: r.id, n });
    });
    return out;
  }

  // The match `findIdx` (counted over all matches): its row.
  findRow(matches) {
    let k = this.findIdx;
    for (const m of matches) { if (k < m.n) return m; k -= m.n; }
    return matches[matches.length - 1] ?? null;
  }

  findStep(d, rows, cx) {
    const matches = this.findMatches(rows);
    const total = matches.reduce((n, m) => n + m.n, 0);
    if (!total) return;
    this.findIdx = (this.findIdx + d + total) % total;
    this.findJump = true;
    cx.notify();
  }

  // Matched words in bold, outside code (for the message's markdown).
  findMark(text) {
    const q = this.findQuery();
    if (!q || /[*_`\[\]\\]/.test(q)) return text;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return String(text).split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(re, (m) => `**${m}**`))).join("");
  }

  // The find bar: the box, how many, up and down, earlier messages, close.
  findBar(t, rows) {
    const matches = this.findMatches(rows);
    const total = matches.reduce((n, m) => n + m.n, 0);
    const q = this.findQuery();
    const count = !q ? "" : total ? `${Math.min(this.findIdx, total - 1) + 1} of ${total}` : "No matches";
    const icon = (id, path, fn) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .child(svg(path).size(14));
    const take = (fn) => (_e, cx) => { fn(cx); cx.stop_propagation(); cx.notify(); };
    return h_flex().id("chat-find").flex_none().w_full().h(40).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.background)
      .key_context("chat_find")
      .on_action("chat_find_close", take((cx) => this.closeFind(cx)))
      .on_action("chat_find_next", take((cx) => this.findStep(1, rows, cx)))
      .on_action("chat_find_prev", take((cx) => this.findStep(-1, rows, cx)))
      .child(svg("mods/chat/search.svg").size(14).flex_none().text_color(t.dim))
      .child(Input.new(this.findBox).flex_1().text_size(13).text_color(t.foreground))
      .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5).text_color(t.dim).child(count))
      .when(Boolean(this.start), (el) => el.child(h_flex().id("find-earlier").h(22).px(8).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.loadEarlier(cx); })
        .child(this.loadingEarlier ? "Loading…" : "Search earlier")))
      .child(icon("find-prev", "mods/chat/chevron-up.svg", (cx) => this.findStep(-1, rows, cx)))
      .child(icon("find-next", "mods/chat/chevron-down.svg", (cx) => this.findStep(1, rows, cx)))
      .child(icon("find-x", "mods/chat/x.svg", (cx) => this.closeFind(cx)));
  }

  // A reply's reference was clicked: the message it answers, scrolled to and lit up a moment
  // (the light fades natively: one flip of its target, no timer driving frames).
  goTo(to, before, rows) {
    const i = rows.findIndex((r) => r.id === before);
    const target = [...rows.slice(0, i < 0 ? rows.length : i)].reverse().find((r) => (r.kind === "user" || r.kind === "agent") && r.text && names(r.text, String(to).slice(0, 60)));
    if (!target) return;
    this.pinned = false;
    // A jump into a folded reply opens it.
    if (target.blk) this.unfolded.add(target.blk);
    this.scroll.scroll_to_item(rows.indexOf(target), "center");
    this.flash = { id: target.id, on: true };
  }

  // ---- leaving, closing ---------------------------------------------------------------------

  // Back to the terminal: the header's switch (pane-sandbox) puts the agent's terminal back in
  // this pane's spot. It acts on the focused pane, so focus this one first.
  toTerminal() {
    const mine = this.myPane();
    if (!mine) return;
    run("pane.focus", { pane: mine });
    run("pane-sandbox.toggle");
  }

  // The agent ended: its pane would have closed, so this one does.
  closeSelf() {
    const mine = this.myPane() ?? this.lastPane;
    if (mine) run("pane.close", { pane: mine });
  }

  // ---- message actions ----------------------------------------------------------------------

  // The column's left and right edges in the pane, for the action buttons under messages.
  edges() {
    const outer = Math.min(this.width, COLUMN + 36);
    const left = (this.width - outer) / 2 + 18;
    return { left, right: left + outer - 36 };
  }

  // A message's band, every part in order with its left edge in the pane: { what, x, w,
  // hover (shown only on hover), pill? }. The time takes a fixed width, so the places never
  // depend on how its digits draw.
  barLayout(bar) {
    const { left, right } = this.edges();
    const time = clock(bar.at);
    const parts = [];
    let at = 0;
    const add = (what, w, gap, more = {}) => { at += parts.length ? gap : 0; parts.push({ what, x: at, w, ...more }); at += w; };
    if (time) add("time", time.length > 5 ? 82 : 38, 0, { hover: true, text: time });
    for (const a of bar.acts) add(a, ACT, ACT_GAP, { hover: true });
    const pills = () => (bar.pills ?? []).forEach((p, i) => add(`pill:${p.emoji}`, PILL, i ? PILL_GAP : PILL_EDGE, { pill: p }));
    if (bar.side === "user") { add("react", ACT, ACT_GAP, { hover: true }); pills(); }
    else { pills(); add("react", ACT, bar.pills?.length ? PILL_EDGE : ACT_GAP, { hover: true }); }
    const x0 = bar.side === "user" ? right - at : left;
    for (const p of parts) p.x += x0;
    return { x: x0, w: at, parts };
  }

  // Which part of a band the press was on (rows take no handlers of their own): the band is a
  // row of its own, so the list names it exactly; across, barLayout()'s places. The time
  // isn't a button.
  hitBar(row) {
    const x = this.press?.x;
    if (row.kind !== "band" || x === undefined || Date.now() - (this.press?.at ?? 0) > 3000) return null;
    const p = this.barLayout(row.bar).parts.find((p) => p.what !== "time" && x >= p.x && x <= p.x + p.w);
    if (p) this.hitLeft = p.x;
    return p?.what ?? null;
  }

  act(row, what, cx) {
    if (!what) return;
    // row: a message's bar ({ id, of, target, text, side, acts }) or its footer row.
    if (what === "copy") this.copy(row.text, row.id, cx);
    if (what === "reply") {
      const t = row.text.replace(/\s+$/, "");
      this.quote = { text: t.length > 280 ? t.slice(0, 279).trimEnd() + "…" : t };
      this.box.focus();
      this.saveSoon(cx);
    }
    if (what === "annotate") this.annotate(row, cx);
    if (what === "rewind") this.rewind(row, cx);
    if (what === "fork") this.fork(cx);
    if (what === "react") { this.keepIcons = row.of; this.openReactions(row, this.hitLeft); }
    // A pill: your reaction on or off.
    if (what.startsWith("pill:")) this.toggleReaction(row.of, row.target, what.slice(5), cx);
  }

  // "Ask about this" (a reply's or a picture's band): into the box as an annotation, with a
  // comment of its own, sent with the next message (notesTag()). Herdr can't read a selection
  // within a message, so it's the whole of one.
  annotate(row, cx) {
    if (this.notes.some((n) => n.of === row.of)) return;
    const comment = InputState.new({ placeholder: "Add an optional comment…" });
    comment.on("submit", (_e, cx) => { this.box.focus(); cx.notify(); });
    // Its quote, editable once opened (click the annotation): cut it to the part you mean.
    const text = String(row.text ?? "").trim();
    const quote = TextareaState.new({ value: text });
    quote.set_auto_grow(2, 10);
    this.notes.push({ of: row.of, text, paths: row.paths ?? [], comment, quote, open: false });
    comment.focus();
    cx.notify();
  }

  // ---- reactions ------------------------------------------------------------------------------

  // A message's reactions as pills: { emoji, you, agent }, the log's word with yours just sent.
  pills(id) {
    if (!id) return [];
    const list = [...(this.conv?.reactions?.get(id) ?? [])];
    const mine = this.myReacts.get(id);
    if (mine) for (const [emoji, on] of mine) {
      const i = list.findIndex((r) => r.by === "you" && r.emoji === emoji);
      if (on && i < 0) list.push({ emoji, by: "you" });
      if (!on && i >= 0) list.splice(i, 1);
    }
    const by = new Map();
    for (const r of list) {
      const p = by.get(r.emoji) ?? { emoji: r.emoji, you: false, agent: false };
      p[r.by === "you" ? "you" : "agent"] = true;
      by.set(r.emoji, p);
    }
    return [...by.values()];
  }

  // The emoji picker (mods/chat-react), anchored to the button that was pressed: its left edge
  // at the button's, above it when there is room, else below; inside the pane's window area.
  openReactions(row, anchor) {
    const W = 360, H = 420;
    const p = this.pressWin, local = this.press;
    let at = "pointer";
    if (p && local?.x !== undefined) {
      const paneX = p.x - local.x, paneY = p.y - (local.y ?? 0);
      const left = anchor ?? local.x;
      const x = Math.max(8, Math.min(paneX + left, paneX + this.width - W - 8));
      const rowTop = p.y - 14, rowBottom = p.y + 14;
      const y = rowTop - H - 4 >= 8 ? rowTop - H - 4 : Math.min(rowBottom + 4, paneY + (this.height ?? 800) - H - 8);
      at = { x, y: Math.max(8, y) };
    }
    const fr = this.frequent(18);
    openOverlay({ mod: "chat-react", kind: "popup", width: W, height: H, at,
      props: { pane: this.myPane(), target: row.of, text: row.target, height: H, width: W,
        frequent: [...fr, ...FREQUENT.filter((e) => !fr.includes(e))].slice(0, Math.max(FREQUENT.length, fr.length)),
        mine: this.pills(row.of).filter((p) => p.you).map((p) => p.emoji) } });
  }

  // How often and how lately you used each emoji (data/chat-emoji-uses.json): Slack's
  // frecency, each of the last ten uses weighed by how long ago it was.
  frequent(n) {
    const H = 3600000, now = Date.now();
    const weight = (age) => [[4 * H, 100], [24 * H, 80], [72 * H, 60], [168 * H, 40], [720 * H, 20], [2160 * H, 10]].find(([upTo]) => age <= upTo)?.[1] ?? 0;
    const score = (u) => (u.t?.length ? (u.n * u.t.reduce((s, t) => s + weight(now - t), 0)) / u.t.length : 0);
    return Object.entries(this.uses ?? {}).map(([e, u]) => [e, score(u)]).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, n).map(([e]) => e);
  }


  useEmoji(emoji) {
    const u = this.uses[emoji] ?? { n: 0, t: [] };
    this.uses = { ...this.uses, [emoji]: { n: u.n + 1, t: [Date.now(), ...u.t].slice(0, 10) } };
    fs.mkdir(`${appHome()}/data`, { recursive: true }).then(() => fs.writeFile(`${appHome()}/data/chat-emoji-uses.json`, JSON.stringify(this.uses))).catch(() => {});
  }

  // Your reaction on (or off) a message: one tag line to the agent, shown at once.
  // While the agent waits on the person (a menu, a question), it waits in the queue instead.
  toggleReaction(id, text, emoji, cx) {
    const on = !this.pills(id).some((p) => p.emoji === emoji && p.you);
    const mine = new Map(this.myReacts.get(id) ?? []);
    mine.set(emoji, on);
    this.myReacts.set(id, mine);
    if (on) this.useEmoji(emoji);
    const line = `<hc from="person" ${on ? "reaction" : "reaction-removed"}="${emoji}" to="${excerpt(text)}"/>`;
    const st = this.status();
    if (st === "blocked" || this.asks.length) {
      this.queue.push({ id: `r${Date.now()}`, text: line, files: [], quote: null, raw: true, label: on ? `${emoji} reaction` : `${emoji} reaction removed` });
      this.saveSoon(cx);
    } else hc(["send", this.addr, line]);
    cx.notify();
  }

  copy(text, id, cx) {
    cx.write_to_clipboard(text);
    this.copied = id;
    cx.timer.after(1500, (cx) => { if (this.copied === id) { this.copied = null; cx.notify(); } });
  }

  // The CLI's own rewind, on that message as nearly as it can: Claude Code's /rewind lists
  // the prompts with the newest last (Up once per later prompt); Codex's Esc Esc browses the
  // transcript from the last prompt (Left once per later prompt). Then the terminal shows it.
  rewind(row, cx) {
    if (this.status() === "working") { toast({ title: "The agent is working", body: "Stop it first, then rewind.", level: "info" }); return; }
    const users = (this.conv?.items ?? []).filter((x) => x.kind === "user" && !x.from && !/^\//.test(x.text ?? ""));
    const i = users.findIndex((u) => u.id === row.of);
    const back = i < 0 ? 1 : users.length - i;
    cx.spawn(async (cx) => {
      if (this.kind === "claude") {
        await hc(["send", this.addr, "/rewind"]);
        await cx.sleep(700);
        await hc(["keys", this.addr, ...Array(back).fill("up")]);
      } else {
        await hc(["keys", this.addr, "esc", "esc"]);
        await cx.sleep(500);
        if (back > 1) await hc(["keys", this.addr, ...Array(back - 1).fill("left")]);
      }
      this.toTerminal();
    });
  }

  // A copy of this conversation, continued in a new tab of this space (the CLI's own fork).
  fork(cx) {
    const session = agent.sessionOf(this.kind, this.path);
    if (!session) { toast({ title: "Can't fork", body: "This conversation has no saved session.", level: "info" }); return; }
    const tab = panes().find((p) => p.pane === this.myPane())?.tab;
    const space = spaces().find((s) => s.tabs.some((x) => x.id === tab));
    const folder = this.t?.foreground?.cwd ?? this.t?.cwd ?? undefined;
    // Through agent/launch, as the + menu starts agents: sandboxed when this one is.
    const box = Boolean(this.t?.labels?.["herdr.sandbox"]);
    run("tab.new", { space: space?.id, folder, argv: [`${appHome()}/agent/launch`, ...(box ? ["--sandbox"] : []), ...agent.forkArgv(this.kind, this.argv, session)] });
  }

  // ---- model button and picker -----------------------------------------------------------------

  current() {
    if (!this.kind) return null;
    // A resumed conversation's log names the model it ran on before: until this process
    // writes, its arguments and settings say what it runs on.
    let meta = this.conv?.meta ?? {};
    const born = this.t?.created_ms;
    if (born && meta.at && meta.at < born) meta = { used: meta.used, window: meta.window };
    const c = agent.current(this.kind, this.argv, meta, this.dflt);
    // An effort picked (applyPick()) shows at once, until the log agrees: a reply already on its
    // way when it changed still says the old one. A log that disagrees long after (changed in the
    // terminal) wins.
    const live = this.liveEffort;
    if (c && live && !(meta.at > live.at && (meta.effort === live.effort || meta.at - live.at > 30000))) c.effort = live.effort;
    return c;
  }

  // Claude Code changes effort in place, even mid-turn (the turn going on takes it at once):
  // /effort opens its slider at the current level; all the way left is low, then right to the
  // level, and s keeps it for this session only. (Enter would save it to ~/.claude/settings.json,
  // for every later agent, and a sandboxed agent can't write that file.) No restart: the
  // conversation and its cache stay. About half a second.
  setEffort(effort, cx) {
    const i = agent.CLAUDE_EFFORTS.indexOf(effort);
    if (i < 0) return Promise.reject(new Error(`Claude Code has no effort "${effort}".`));
    return this.typed(async () => {
      const r = await hc(["send", this.addr, "/effort"]);
      if (r.code !== 0) throw new Error(refusal(r).message);
      // The slider is up once its hint shows; keys sent before then would land in the prompt.
      let up = false;
      for (let n = 0; n < 40 && !up; n++) {
        if (n) await cx.sleep(50);
        up = /←\/→ to adjust/.test((await hc(["read", this.addr, "--lines", "20"]).catch(() => null))?.stdout ?? "");
      }
      if (!up) throw new Error("Claude Code didn't open its effort slider.");
      await hc(["keys", this.addr, ...Array(agent.CLAUDE_EFFORTS.length).fill("left"), ...Array(i).fill("right"), "s"]);
    });
  }

  // One thing typed into the agent's terminal at a time (a message, the effort slider's keys),
  // so a message sent just after an effort pick doesn't land in the slider.
  typed(fn) {
    const run = (this.typeQueue ?? Promise.resolve()).then(fn);
    this.typeQueue = run.catch(() => {});
    return run;
  }

  // The model picker (mods/chat-models), as a popover just above the model button: the chat
  // works out everything it shows (both agents' models, efforts, permission modes) and passes
  // it as props. `at`: where the button was pressed, in the window.
  openPicker(at, cx, name = null) {
    const c = this.current();
    if (!c || this.picking) return;
    this.picking = true;
    cx.spawn(async (cx) => {
      try {
        const stale = !this.pickCache || Date.now() - this.pickCache.at > 60000 || this.pickCache.machine !== this.machine;
        if (stale) {
          const [claude, codex, known] = await Promise.all([agent.defaults("claude", this.machine), agent.defaults("codex", this.machine),
            knownAgents({ on: this.machine }).catch(() => [])]);
          const prog = (key) => known.find((a) => a.key === key || (a.run ?? [])[0] === key);
          this.pickCache = { at: Date.now(), machine: this.machine, dflts: { claude, codex },
            icons: Object.fromEntries(["claude", "codex"].map((k) => [k, { icon: prog(k)?.icon ?? null, tint: Boolean(prog(k)?.tint) }])),
            installed: Object.fromEntries(["claude", "codex"].map((k) => [k, prog(k) ? prog(k).installed !== false : true])) };
        }
        const { dflts, icons, installed } = this.pickCache;
        if (this.kind) dflts[this.kind] = this.dflt ?? dflts[this.kind];
        const currentRow = agent.rowFor(c.agent, c);
        // Installed agents only (and always the one running).
        const menus = Object.fromEntries(["claude", "codex"].filter((k) => k === c.agent || installed[k])
          .map((k) => [k, agent.menuFor(k, dflts[k], k === c.agent ? currentRow : null)]));
        // As tall as the menu can get (chat-models' sizes): border and padding, Model header and
        // rows, separator, Reasoning header and levels, Fast, Permissions, Restart.
        const rows = Object.values(menus).reduce((n, m) => n + m.models.length, 0);
        const W = 300, H = 2 + 10 + 26 + 31 * rows + 9 + 26 + 34 + 31 + 31 + 33;
        openOverlay({ mod: "chat-models", kind: "popup", frame: "none", width: W, height: H,
          at: at ? { x: Math.max(8, at.x - W + 90), y: Math.max(8, at.y - H - 10) } : "pointer",
          props: { pane: this.myPane(), height: H, select: name ? findModel(menus, name) : null, liveEffort: c.agent === "claude",
            current: { agent: c.agent, model: currentRow, effort: c.effort ?? null, fast: c.fast, perm: c.perm ?? null },
            menus, icons, permDefault: { claude: dflts.claude?.mode ?? "manual", codex: "auto" } } });
      } finally {
        this.picking = false;
        cx.notify();
      }
    });
  }

  // /model typed in the box: the picker over the model button, with the model named chosen.
  // Without a picker (no pane, no agent yet) it only says why nothing went.
  modelCommand(name, cx) {
    const b = this.composerAt;
    if (!this.myPane() || !this.current()) {
      this.note = { id: `note-${Date.now()}`, text: "Not sent: /model would change the model for every later agent." };
      cx.timer.after(6000, (cx) => { this.note = null; cx.notify(); });
      return;
    }
    this.openPicker(b ? { x: b.x + b.width - 90, y: b.y + b.height - 18 } : this.pickAt, cx, name);
  }

  // Restarts the agent with what the picker chose; this chat follows the new one.
  applyPick(pick, cx) {
    const mine = this.myPane();
    if (this.restarting || !mine || !this.t) return;
    // Only the effort changed, on Claude Code: set in place, no restart.
    const cur = this.current();
    if (this.kind === "claude" && pick.agent === "claude" && cur && pick.effort && pick.effort !== cur.effort
      && (pick.model ?? agent.rowFor("claude", cur)) === agent.rowFor("claude", cur) && Boolean(pick.fast) === Boolean(cur.fast) && (pick.perm ?? cur.perm) === cur.perm) {
      // The pick shows at once (as T3 Code's does) and Claude Code takes it at once, mid-turn
      // too. Only a dialog of its own (a question, a permission, its start screen) holds it, as
      // the slider's keys would answer the dialog. A later pick replaces a waiting one.
      this.liveEffort = { effort: pick.effort, at: Date.now() };
      this.pendingEffort = pick.effort;
      cx.spawn(async (cx) => {
        while (this.status() === "blocked" || this.asks.length || openCard(this.addr)) await cx.sleep(500);
        if (this.pendingEffort !== pick.effort) return;
        this.pendingEffort = null;
        try {
          await this.setEffort(pick.effort, cx);
        } catch (e) {
          this.liveEffort = null;
          toast({ title: "Effort didn't change", body: plainError(e), level: "error" });
        }
        cx.notify();
      });
      return;
    }
    this.restarting = true;
    cx.spawn(async (cx) => {
      try {
        const t = JSON.parse((await hc(["get", this.addr, "--json"])).stdout);
        const built = agent.argvFor(pick, { agent: this.kind, argv: agent.own(t.foreground?.argv ?? []), session: agent.sessionOf(this.kind, this.path) });
        this.swapping = true;
        const next = await agent.restart(t, built, mine);
        this.follow_to(next);
        this.note = { id: `note-${Date.now()}`, text: built.resume ? "Restarted. The conversation continues." : `Started ${agent.NAMES[pick.agent]} with a handoff.` };
        cx.timer.after(6000, (cx) => { this.note = null; cx.notify(); });
      } catch (e) {
        toast({ title: "The agent didn't restart", body: plainError(e), level: "error" });
      }
      this.swapping = false;
      this.restarting = false;
      cx.notify();
    });
  }

  // A notice's or a status line's button: primary is the view's one main action.
  button(id, label, icon, kind, t, fn) {
    const primary = kind === "primary";
    return h_flex().id(id).h(28).flex_none().gap(6).items_center().rounded(7).cursor_pointer().text_size(12.5).font_medium()
      .pl(icon ? 7 : 10).pr(10)
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(kind === "secondary", (el) => el.border_1().border_color(t.input).bg(t.background).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .when(kind === "ghost", (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .when(Boolean(icon), (el) => el.child(svg(icon).size(14).flex_none()))
      .child(label);
  }

  // Keeps the newest row in view, once this render's rows (and their measured heights) are in.
  follow_bottom(rows) {
    if (this.reanchor) {
      this.reanchor = false;
      const i = this.anchor && Date.now() < this.anchor.until ? rows.findIndex((r) => r.id === this.anchor.id) : -1;
      if (i >= 0) this.scroll.scroll_to_item(i, "top");
    }
    if (!this.stick) return;
    this.stick = false;
    if (this.pinned) this.scroll.scroll_to_bottom();
  }

  // A full-size message instead of the conversation: finding it, not found, ended.
  notice(t, title, body, actions = []) {
    return v_flex().flex_1().min_h(0).items_center().justify_center().px(24).gap(6)
      .child(svg("mods/workspace-chrome/terminal.svg").size(18).flex_none().text_color(t.dim))
      .child(div().pt(4).font_medium().text_color(t.foreground).child(title))
      .when(Boolean(body), (el) => el.child(div().max_w(360).text_center().text_size(12.5).text_color(t.muted).child(body)))
      .when(actions.length > 0, (el) => el.child(h_flex().pt(8).gap(6).children(actions)));
  }

  // ---- the conversation's rows ----------------------------------------------------------------

  // Codex's way with a finished turn: the person's message, "Worked for 4m 5s", the last reply.
  // What came between (replies on the way, thoughts, tool steps) folds into that row and opens
  // on a click; the turn under way shows all of it as it comes. Questions, pictures and
  // artifacts stay where they were.
  foldTurns(items, working) {
    const FOLDS = new Set(["agent", "thought", "tools", "diff"]);
    const out = [];
    let i = 0;
    while (i < items.length) {
      if (items[i].kind !== "user") { out.push(items[i++]); continue; }
      const u = items[i];
      out.push(u);
      let j = i + 1;
      while (j < items.length && items[j].kind !== "user") j++;
      const turn = items.slice(i + 1, j);
      i = j;
      let fin = -1;
      for (let k = turn.length - 1; k >= 0; k--) if (turn[k].kind === "agent") { fin = k; break; }
      if ((working && j === items.length) || !turn.slice(0, Math.max(0, fin)).some((x) => FOLDS.has(x.kind))) { out.push(...turn); continue; }
      const id = `w:${u.id}`, end = turn[fin].at ?? 0;
      out.push({ kind: "worked", id, secs: u.at && end > u.at ? Math.round((end - u.at) / 1000) : null });
      const open = this.opened.has(id);
      // Opened, what it folds is drawn faded (rowBare(), dim), so the last reply stands out.
      turn.forEach((x, k) => { if (k >= fin || !FOLDS.has(x.kind)) out.push(x); else if (open) out.push({ ...x, dim: true }); });
    }
    return out;
  }

  rows() {
    const out = [];
    // The rows from `from` on are one message's block (spaced()).
    const block = (from, blk) => { for (let k = from; k < out.length; k++) out[k] = { ...out[k], blk }; };
    if (this.start === 0) out.push({ kind: "top", id: "top" });
    else if (this.start) out.push({ kind: "loading", id: "loading" });
    const working = this.status() === "working";
    const items = this.foldTurns(this.conv?.items ?? [], working);
    const arts = this.resolveArts(items);
    this.loadAskEnds();
    // Start screens answered or gone (screens.js).
    const screenEnds = (this.addr ? cardsOf(this.addr) : []).filter((c) => c.state !== "open")
      .map((c) => ({ at: c.opened, row: { kind: "askend", id: `se:${c.id}`, text: `${c.cli}'s start screen · ${c.how}` } }));
    // Cards waiting on the person, in the timeline at their moment (DECISIONS, Chat): the
    // agent's question in place of its "Asked you" line, the rest by time.
    const cards = this.timelineCards();
    const ownQ = cards.find((c) => c.question);
    let qAt = -1;
    if (ownQ) for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "ask" && !items[i].closed) { qAt = i; break; }
    // What isn't in the log, each before the first thing said after its moment.
    const timed = [...this.askEnds.map((e) => ({ at: e.at, row: { kind: "askend", id: `ae:${e.id}`, text: `${e.title} · ${e.how}` } })), ...screenEnds,
      ...cards.filter((c) => !(c === ownQ && qAt >= 0)).map((c) => ({ at: c.at, card: c }))]
      .sort((a, b) => a.at - b.at);
    // A card is a run of strips, one list row each (strips.js), kept together as one block.
    const putCard = (c) => c.strips.forEach((s, j) => out.push({ kind: "cardstrip", id: `cs:${c.id}:${s.key}`, s, blk: c.id, first: j === 0, last: j === c.strips.length - 1,
      sig: strips.sig(s), owner: c.owner, ask: c.ask }));
    const put = (e) => { if (e.card) putCard(e.card); else out.push(e.row); };
    let ti = 0;
    // A day's line where a new day starts (Today, Yesterday, a weekday, a date), the first too.
    const days = new Set();
    const dated = (at) => {
      if (!(at > 1e12)) return;
      const d = dayOf(at);
      if (!days.has(d) && d > Math.max(-1, ...days)) { days.add(d); out.push({ kind: "day", id: `day:${d}`, text: dayLabel(at) }); }
    };
    for (let i = 0; i < items.length; i++) {
      const x = items[i];
      while (ti < timed.length && x.at && timed[ti].at < x.at) { dated(timed[ti].at); put(timed[ti++]); }
      if (i === qAt) { putCard(ownQ); continue; }
      if (x.kind !== "mark") dated(x.at);
      if (x.kind === "artifact") {
        // A published artifact: its card (the latest publish of it; earlier ones a line), or a
        // quiet line while the registry doesn't list it yet.
        const r = arts.get(x.id);
        if (r) out.push({ kind: "artifact", id: x.id, art: r.id, title: r.title, text: r.title, version: r.version, v: r.v, line: !r.latest });
        else if (Date.now() - (x.at ?? 0) < 180000) out.push({ kind: "artifact", id: x.id, pending: true, text: "" });
        continue;
      }
      if (x.kind === "user" && this.brief(x, i)) {
        // Not typed by the person: a launch brief or another agent's message, as a quiet row.
        // A fresh start's handover says it all in its label.
        const restart = /^<restart>/.test(x.text ?? "");
        out.push({ kind: "brief", id: x.id, label: this.brief(x, i), text: restart ? x.text.replace(/<\/?restart>/g, "") : x.from ? unsigned(x.text) : x.text, bare: restart });
        continue;
      }
      if (x.kind === "user") {
        const from = out.length;
        if (x.replyTo) out.push({ kind: "replyref", id: `rr:${x.id}`, to: x.replyTo, of: x.id, side: "user" });
        // Rewind goes to a prompt; a /command isn't one.
        out.push(x);
        if (x.paths?.length) out.push({ kind: "imgs", id: `i:${x.id}`, paths: x.paths });
        // Its actions in a band row under it (the row above draws them too: band()).
        if (x.text) {
          const bar = { id: `b:${x.id}`, of: x.id, target: x.text, text: x.text, side: "user", at: x.at, pills: this.pills(x.id),
            acts: ["reply", "copy", ...(/^\//.test(x.text) || x.from ? [] : ["rewind"])] };
          out[out.length - 1] = { ...out[out.length - 1], bar };
          out.push({ kind: "band", id: `ab:${x.id}`, bar });
        }
        block(from, x.id);
        continue;
      }
      if (x.kind === "agent") {
        const ps = parts(x.text);
        const first = out.length;
        // A long reply: its first lines (the part where they end cut off there), then Show more.
        const fold = this.foldOf(x, ps);
        const clip = (n) => (fold && !fold.open ? fold.clips.get(n) : undefined);
        if (ps.length === 1 && ps[0].type === "md") out.push(clip(0) ? { ...x, clip: clip(0) } : x);
        else ps.forEach((p, n) => {
          if (fold && !fold.open && n > fold.last) return;
          if (p.type === "md") out.push({ kind: "agent", id: `${x.id}:${n}`, text: p.text, clip: clip(n), dim: x.dim });
          else {
            out.push({ kind: "codehead", id: `${x.id}:h${n}`, lang: p.lang, code: p.code, dim: x.dim });
            out.push({ kind: "code", id: `${x.id}:c${n}`, lang: p.lang, code: p.code, clip: clip(n), dim: x.dim });
          }
        });
        if (fold) out.push({ kind: "fold", id: `fold:${x.id}`, of: x.id, open: fold.open, dim: x.dim });
        // Pictures the reply points at (![…](/path)): drawn under it.
        if (x.paths?.length) out.push({ kind: "imgs", id: `i:${x.id}`, paths: x.paths, side: "agent" });
        // Every message of the agent's gets its own actions and reactions, also while it works;
        // only the one it may still be writing (the newest, while working) waits. The actions go
        // under its last row.
        if (!(working && i === items.length - 1) && out.length > first) {
          const bar = { id: `b:${x.id}`, of: x.id, target: x.text, text: x.text, side: "agent", at: x.at, pills: this.pills(x.id),
            acts: ["annotate", "copy", ...(this.kind ? ["fork"] : [])] };
          out[out.length - 1] = { ...out[out.length - 1], bar };
          out.push({ kind: "band", id: `ab:${x.id}`, bar });
        }
        block(first, x.id);
      } else if (x.kind === "thought") {
        // Narration between steps: Ask about this and Copy under it, as a reply has.
        const first = out.length;
        out.push(x);
        if (!(working && i === items.length - 1)) {
          const bar = { id: `b:${x.id}`, of: x.id, target: x.text, text: x.text, side: "agent", at: x.at, pills: this.pills(x.id), acts: ["annotate", "copy"] };
          out[out.length - 1] = { ...x, bar };
          out.push({ kind: "band", id: `ab:${x.id}`, bar, dim: x.dim });
        }
        block(first, x.id);
      } else if (x.kind === "shots") {
        // show-your-work: what the agent shows you (a screenshot, a recording), on its side,
        // with Ask about this under it.
        const from = out.length;
        const bar = { id: `b:${x.id}`, of: x.id, target: x.title || "picture", text: x.title ?? "", side: "agent", at: x.at, pills: this.pills(x.id), acts: ["annotate"], paths: x.paths };
        out.push({ kind: "imgs", id: `i:${x.id}`, paths: x.paths, side: "agent", title: x.title, bar, dim: x.dim });
        out.push({ kind: "band", id: `ab:${x.id}`, bar });
        block(from, x.id);
      } else if (x.kind !== "mark") out.push(x);
    }
    while (ti < timed.length) { dated(timed[ti].at); put(timed[ti++]); }
    // Words that answered a card, shown at once, until the log has them right after their
    // question (log.js answers()): they are the newest thing said, so they go last.
    if (this.replied.length || this.pending.length) dated(Date.now());
    for (const r of this.replied) out.push({ kind: "user", id: `rp:${r.id}`, text: r.text });
    for (const p of this.pending) {
      const from = out.length;
      if (p.replyTo) out.push({ kind: "replyref", id: `rr:${p.id}`, to: p.replyTo, of: p.id, side: "user" });
      out.push({ kind: "pending", id: p.id, text: p.text, files: p.files, notes: p.notes, failed: p.failed, late: p.late, delivered: p.delivered });
      if (p.paths?.length) out.push({ kind: "imgs", id: `i:${p.id}`, paths: p.paths, faded: !p.delivered });
      block(from, p.id);
    }
    if (this.note) out.push({ kind: "note", id: this.note.id, text: this.note.text });
    if (out.length) out.push({ kind: "end", id: "end" });
    return this.spaced(out);
  }

  // How a long reply folds, or null when it's short (or holds what Find looks for): { open,
  // clips: part → px its words show, last: the last part shown }. Its parts' heights are
  // estimated from their words; one drawn (natural) shorter than that isn't folded after all.
  foldOf(x, ps) {
    const q = this.findQuery().toLowerCase();
    if (q && String(x.text).toLowerCase().includes(q)) return null;
    const w = Math.max(240, Math.min(this.width - 36, COLUMN));
    const est = ps.map((p) => (p.type === "md" ? wrapLines(p.text, w) * LINE_H : 34 + 16 + p.code.split("\n").length * 19));
    const drawn = ps.length === 1 ? this.natural.get(x.id) : null;
    if ((drawn ?? est.reduce((a, b) => a + b, 0)) <= FOLD_TALL * LINE_H) return null;
    if (this.unfolded.has(x.id)) return { open: true, clips: new Map(), last: ps.length - 1 };
    const clips = new Map();
    let left = FOLD * LINE_H, last = ps.length - 1;
    for (let n = 0; n < ps.length; n++) {
      if (est[n] < left && n < ps.length - 1) { left -= est[n]; continue; }
      clips.set(n, Math.max(3 * LINE_H, ps[n].type === "md" ? left : left - 34));
      last = n;
      break;
    }
    return { open: false, clips, last };
  }

  // Show more / Show less. Opening grows the reply downward from where it is, and the list
  // stops following the newest, so what is being read stays put; closing one read from far
  // down brings its start back into view.
  toggleFold(row, rows) {
    this.pinned = false;
    if (!this.unfolded.has(row.of)) { this.unfolded.add(row.of); return; }
    this.unfolded.delete(row.of);
    const i = rows.findIndex((r) => r.blk === row.of && r.kind !== "replyref");
    if (i >= 0 && i <= (this.range?.start ?? 0)) this.scroll.scroll_to_item(i, "top");
  }

  // One even rhythm (DECISIONS, Chat > Spacing). Rows of one block sit as they are; at a
  // block's edges a row drops its outer room (top0 / bot0), and between blocks goes one gap
  // row, so every block is GAP from the next: a message with its band, a run of quiet lines
  // (tools, "Message from …", artifact lines) sitting tight together, a card. A band is always
  // ACT_ROW: BAND_IN of air, then the actions' row at its foot, shown or not.
  spaced(rows) {
    const quiet = (r) => r.kind === "tools" || r.kind === "brief" || r.kind === "askend" || (r.kind === "artifact" && (r.line || r.pending));
    const of = (r) => r.blk ?? (quiet(r) ? "quiet" : r.id);
    // How far a row's words sit inside its edge once its outer room is gone (a reply line's
    // small text sits in an 18 px line; it only ever starts a block).
    const inset = (r, edge) => (quiet(r) ? QUIET_IN[edge] : r.kind === "replyref" ? 5 : 0);
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      let r = rows[i];
      const prev = rows[i - 1], next = rows[i + 1];
      const top0 = !prev || of(prev) !== of(r), last = !next || of(next) !== of(r);
      // A message's last row sits flush on its band.
      const bot0 = last || next?.kind === "band";
      if (r.kind === "band") {
        r.bar.box = { top: BAND_IN, h: ACT };
        out.push({ ...r, h: ACT_ROW });
      } else if (top0 || bot0) out.push({ ...r, top0, bot0 });
      else out.push(r);
      if (last && next) {
        const h = Math.max(0, GAP - (r.kind === "band" ? 0 : inset(r, "bottom")) - inset(next, "top"));
        out.push({ kind: "gap", id: `g:${r.id}`, h });
      }
    }
    return out;
  }

  // Who sent a message with hc (<hc from="t7 reviewer">): "Reviewer", or its name, never its
  // terminal address. An artifact's form says its title; the person's own lines are "You". A
  // sender outside any terminal (from="ppid:123") or one gone goes by the name it signed the
  // message with (text: "From Reviewer: …"), else "Another agent".
  sender(from, text = null) {
    const [addr, ...rest] = String(from ?? "").trim().split(/\s+/);
    const signed = signedBy(text);
    if (addr === "person") return "You";
    if (/(^|\/)ppid:\d+$/.test(addr ?? "")) return signed || "Another agent";
    if (!/^([\w.-]+\/)?t\d[0-9a-z]*$/.test(addr ?? "")) return String(from);
    // A bare address is on the machine of the agent it was sent to.
    const full = !addr.includes("/") && this.machine ? `${this.machine}/${addr}` : addr;
    const k = terminals().find((x) => x.address === full);
    const name = rest.join(" ") || k?.name || "";
    if (k?.labels?.["herdr.role"] === "reviewer" || /\breview/i.test(name)) return "Reviewer";
    return name || signed || "Another agent";
  }

  // Whose ask a card shows: the CLI's short name ("Claude asks").
  cli() {
    return this.kind === "codex" ? "Codex" : "Claude";
  }

  // The empty box's words: whom it writes to.
  placeholder() {
    return `Message ${agent.NAMES[this.kind] ?? "the agent"}`;
  }

  // A user message the person didn't type, in words for its quiet row, else null: the session's
  // first message when the agent was started from a template or as a handoff; and any message
  // another agent sent with hc.
  brief(x, i) {
    if (x.from) return `Message from ${this.sender(x.from, x.text)}`;
    if (i !== 0 || this.start !== 0) return null;
    if (/^<restart>/.test(x.text ?? "")) return "New session";
    const tpl = this.t?.template ?? null;
    if (/^You are taking over this tab/.test(x.text ?? "") || /^herdr-handoff/.test(tpl ?? "")) return "Handoff from the previous agent";
    if (tpl) return "New session";
    return null;
  }

  // What a row's height depends on: measured once per key and width.
  key(x) {
    const q = this.findQuery();
    const found = q && String(x.text ?? x.code ?? "").toLowerCase().includes(q.toLowerCase()) ? `|f:${q}` : "";
    const open = (x.kind === "tools" || x.kind === "brief") && this.opened.has(x.id);
    const shown = open && x.steps ? x.steps.filter((s) => this.results.get(s.id) != null).length : 0;
    return `${x.id}|${x.kind}${x.closed ? `.${x.closed}` : ""}|${open ? `o${x.steps?.length ?? 1}.${shown}` : ""}|${x.text?.length ?? x.code?.length ?? 0}|${x.from ? 1 : 0}${x.failed ? 1 : 0}${x.late ? 1 : 0}${x.images ? 1 : 0}${x.files?.length ?? 0}|${x.paths?.length ?? 0}${x.paths?.every((p) => this.views[p]) ? "v" : ""}|${(x.pills ?? []).map((p) => p.emoji + (p.you ? 1 : 0) + (p.agent ? 1 : 0)).join("")}|${x.bar ? "b" : ""}${x.kind === "artifact" ? `|a${x.version ?? ""}${x.line ? "l" : ""}${x.pending ? "p" : ""}` : ""}${x.kind === "cardstrip" ? `|cs${x.sig}${x.first ? "F" : ""}${x.last ? "L" : ""}` : ""}|${x.clip ? `c${x.clip}` : ""}${x.open ? "o" : ""}${x.kind === "day" ? x.text : ""}|${x.top0 ? "T" : ""}${x.bot0 ? "B" : ""}${x.h ?? ""}${found}`;
  }

  // A row's height before it is measured: bands and gaps are as tall as spaced() made them.
  guess(x) {
    return x.kind === "band" || x.kind === "gap" ? x.h : this.guessBare(x);
  }

  guessBare(x) {
    const w = Math.min(this.width, COLUMN) - 36;
    const lines = (text, width) => String(text ?? "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length * 7) / Math.max(120, width))), 0);
    switch (x.kind) {
      case "end": return 10;
      case "top": case "loading": case "note": return 36;
      case "brief": return this.opened.has(x.id) ? 32 + lines(x.text, w) * 19 : 20;
      case "replyref": return 22;
      case "imgs": return this.fitThumbs(x.paths).h + 8 + (x.title ? 20 : 0);
      case "codehead": return 34;
      case "code": return 16 + (x.clip ?? String(x.code).split("\n").length * 19);
      case "fold": return 26;
      case "day": return 18;
      case "user": case "pending": return 30 + lines(x.text, w * 0.8 - 24) * 20 + (x.from ? 17 : 0) + ((x.images || x.files?.length) ? 20 : 0) + (x.notes ? 20 : 0)
        + (this.opened.has(`n:${x.id}`) ? (x.noteItems ?? []).reduce((h, n) => h + 10 + lines(n.quote, w * 0.8) * 17 + (n.comment ? 20 : 0), 0) : 0);
      case "agent": return 14 + (x.clip ?? lines(x.text, w) * 21);
      case "thought": return 14 + lines(x.text, w) * 21;
      case "worked": return 41;
      case "gallery": return GALLERY_H + 8;
      case "diff": return 32 + (this.opened.has(x.id) ? 0 : 10 + Math.min(x.lines.length, DIFF_SHOWN) * 18 + (x.lines.length + (x.more ?? 0) > DIFF_SHOWN ? 18 : 0));
      case "tools": return this.opened.has(x.id) ? 26 + x.steps.reduce((n, s) => n + (s.cmd || s.kind === "run" ? 36 : 19), 0) : 20;
      case "artifact": return x.pending || x.line ? 20 : 62;
      case "cardstrip": {
        const s = x.s, edge = (x.first ? 10 : s.gap ?? 8) + (x.last ? 10 : 0);
        const h = s.kind === "title" || s.kind === "text" ? 18 * lines(s.text, w)
          : s.kind === "detail" ? 12 + 16 * Math.min(s.clip ? 11 : Infinity, s.lines?.length ?? 1)
          : { head: 18, controls: 24, option: 32 + (s.desc ? 16 : 0), review: 31, input: 32 }[s.kind] ?? 24;
        return edge + h;
      }
      default: return 60;
    }
  }

  // One row of the conversation. Rows are drawn inside the list's layout: no handlers here,
  // clicks come through the list's on_item_click. A message's last row carries its actions in
  // a band below it, in a layer over the whole row that shows while the pointer is on the row:
  // the row's own hover, so it is always the message under the pointer (the list redraws as
  // the pointer moves, so the hover follows it), and its room is always kept, so nothing moves.
  row(x, t, pre = "") {
    const keep = this.keepIcons === x.bar?.of;
    // The band row: its pills always; the rest while the pointer is on it.
    const box = x.bar?.box ?? { top: 0, h: ACT_ROW };
    if (x.kind === "band") return div().relative().w_full().h(x.h)
      .child(this.bar(x.bar, t, x.h - box.top - box.h, false))
      .child(div().absolute().inset_0().opacity(keep ? 1 : 0).hover((s) => s.opacity(1)).child(this.bar(x.bar, t, x.h - box.top - box.h, true)));
    const el = this.rowBare(x, t, pre);
    if (!x.bar) return el;
    // The message's last row: the same actions drawn just below it, in the band row's place,
    // while the pointer is on the message (its row isn't clipped: see the list).
    return div().relative().w_full().child(el)
      .child(div().absolute().inset_0().opacity(keep ? 1 : 0).hover((s) => s.opacity(1)).child(this.bar(x.bar, t, -box.top - box.h, true)));
  }

  // A band's parts at barLayout()'s places: the hover ones (time, icons, the smiley) or the
  // pills, each drawn in its own layer, so the pills stay while the rest fades in and out.
  bar(bar, t, bottom, hover) {
    const done = this.copied === bar.id;
    const icon = (a) => div().size(ACT).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(done && a === "copy" ? t.foreground : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .child(svg(`mods/chat/${done && a === "copy" ? "check" : ICONS[a]}.svg`).size(14));
    const pill = (p) => h_flex().w(PILL).h(22).gap(4).items_center().justify_center().rounded(11).border_1().cursor_pointer()
      .when(p.you, (el) => el.bg(t.accent + "26").border_color(t.accent))
      .when(!p.you, (el) => el.border_color(t.border).hover((s) => s.bg(t.hover)))
      .child(div().text_size(13).child(p.emoji))
      .child(div().text_size(11.5).font_medium().text_color(p.you ? t.foreground : t.muted).child(String((p.you ? 1 : 0) + (p.agent ? 1 : 0))));
    const { parts } = this.barLayout(bar);
    return div().absolute().left(0).right(0).bottom(bottom).h(bar.box?.h ?? ACT_ROW)
      .children(parts.filter((p) => Boolean(p.hover) === hover).map((p) => div().absolute().top(0).bottom(0).left(p.x).w(p.w).flex().items_center()
        .when(bar.side === "user" && p.what === "time", (el) => el.justify_end())
        .child(p.what === "time" ? div().pr(bar.side === "user" ? 4 : 0).pl(bar.side === "user" ? 0 : 2).text_size(11.5).text_color(t.dim).child(p.text)
          : p.pill ? pill(p.pill) : icon(p.what))));
  }

  rowBare(x, t, pre = "") {
    if (x.dim) return div().w_full().opacity(0.5).child(this.rowBare({ ...x, dim: false }, t, pre));
    // A readable column, centered when the pane is wide.
    // At a block's edge a row drops its outer room there: spaced() puts the gap between blocks.
    const col = (el, px = 18, py = 6) => h_flex().w_full().justify_center()
      .child(div().w_full().max_w(COLUMN + 2 * px).px(px).pt(x.top0 ? 0 : py).pb(x.bot0 ? 0 : py).child(el));
    const pad = (el) => col(el, 18, 7);
    // As Codex shows them: the person's words in a quiet bubble on the right; the agent's as
    // plain text across the column, no bubble.
    const most = Math.max(240, Math.floor(Math.min(this.width, COLUMN) * 0.8));
    const bubble = (text, faded) => h_flex().w_full().justify_end().child(
      div().max_w(most).px(14).py(9).rounded(16).bg(t.raised)
        .text_color(t.foreground).when(faded, (el) => el.opacity(0.55))
        .child(TextView.markdown(`${pre}chat-md-${x.id}`, this.findMark(typed(text)) || " ").selectable(true)));
    const theirs = (text) => h_flex().w_full().justify_start().child(
      div().w_full().text_color(t.foreground)
        .child(x.clip ? this.clipped(t.background, x.clip, div().id(`${pre}fold-in-${x.id}`).flex_none()
          // Its words' drawn height: a reply shorter than it looked isn't folded (foldOf()).
          .on_size_change((size, cx) => { const was = this.natural.get(x.id); if (!was || Math.abs(was - size.height) > 1) { this.natural.set(x.id, size.height); cx.notify(); } })
          .child(TextView.markdown(`${pre}chat-md-${x.id}`, this.findMark(text) || " ").selectable(true)))
          : TextView.markdown(`${pre}chat-md-${x.id}`, this.findMark(text) || " ").selectable(true)));
    const fileLine = (label, icon = "paperclip") => h_flex().gap(5).items_center().text_size(12).text_color(t.dim)
      .child(svg(`mods/chat/${icon}.svg`).size(12).flex_none()).child(div().truncate().child(label));
    const noteLine = (n, open = null) => fileLine(n === 1 ? "1 annotation" : `${n} annotations`, "annotate")
      .when(open !== null, (el) => el.cursor_pointer().hover((s) => s.text_color(t.muted))
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none()));
    // What a sent message's annotations quoted, each with its comment (opened from its count).
    const noteList = (items) => v_flex().max_w(most).gap(8).pt(2).children(items.map((n) => v_flex().w_full().gap(3)
      .child(div().w_full().pl(8).border_l(2).border_color(t.border).text_size(12).text_color(t.muted).whitespace_normal().child(n.quote))
      .when(Boolean(n.comment), (el) => el.child(div().w_full().text_size(12).text_color(t.foreground).whitespace_normal().child(n.comment)))));
    switch (x.kind) {
      case "end":
        return div().w_full().h(10);
      case "gap":
        return div().w_full().h(x.h);
      case "top":
        return pad(div().w_full().text_center().text_size(12).text_color(t.dim).child("Start of conversation"));
      case "loading":
        return pad(div().w_full().text_center().text_size(12).text_color(t.dim).child("Loading earlier…"));
      case "note":
        return pad(div().w_full().text_center().text_size(12).text_color(t.muted).child(x.text));
      case "user":
        return pad(v_flex().w_full().items_end().gap(3)
          .when(Boolean(x.from), (el) => el.child(div().text_size(12).text_color(t.dim).child(`From ${this.sender(x.from, x.text)}`)))
          .when(Boolean(x.text), (el) => el.child(bubble(x.text, false)))
          .when(x.images > (x.paths?.length ?? 0), (el) => el.child(fileLine(x.images === 1 ? "1 image" : `${x.images} images`)))
          .when(x.notes > 0, (el) => el.child(noteLine(x.notes, x.noteItems?.length ? this.opened.has(`n:${x.id}`) : null)))
          .when(this.opened.has(`n:${x.id}`) && x.noteItems?.length > 0, (el) => el.child(noteList(x.noteItems))));
      case "pending":
        return pad(v_flex().w_full().items_end().gap(3)
          .when(Boolean(x.text), (el) => el.child(bubble(x.text, !x.delivered || Boolean(x.failed))))
          .when(x.files?.length > 0, (el) => el.child(fileLine(x.files.join(", "))))
          .when(x.notes > 0, (el) => el.child(noteLine(x.notes)))
          .when(Boolean(x.failed), (el) => el.child(div().text_size(12).text_color(t.blocked).cursor_pointer().child(`Not sent: ${String(x.failed).replace(/\.$/, "")}. Click to try again.`)))
          .when(!x.failed && x.late, (el) => el.child(div().text_size(12).text_color(t.dim).child("Not in the conversation. Check the terminal."))));
      case "replyref":
        // The message this one answers, in one dim line above it.
        return col(h_flex().w_full().h(18).justify_end().child(h_flex().max_w(Math.floor(Math.min(this.width, COLUMN) * 0.6)).gap(5).items_center()
          .cursor_pointer().text_size(11.5).text_color(t.dim).hover((s) => s.text_color(t.muted))
          .child(svg("mods/chat/reply.svg").size(12).flex_none())
          .child(div().min_w(0).truncate().child(x.to))), 18, 2);
      case "brief": {
        const open = this.opened.has(x.id);
        return col(v_flex().w_full().px(6).py(QUIET_PY).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
          .child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
            .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none())
            .child(div().flex_none().text_color(t.muted).child(x.label))
            .when(!open && !x.bare, (el) => el.child(div().flex_1().min_w(0).truncate().child(String(x.text ?? "").split("\n").find((l) => l.trim()) ?? ""))))
          .when(open, (el) => el.child(div().pl(18).pt(6).text_size(12.5).text_color(t.muted)
            .child(TextView.markdown(`${pre}chat-brief-${x.id}`, x.text || " ").selectable(true)))), 12, 0);
      }
      case "imgs": {
        const mine = x.side !== "agent";
        const row = h_flex().w_full().gap(THUMB_GAP).items_start().when(mine, (el) => el.justify_end()).when(!mine, (el) => el.justify_start())
          .when(Boolean(x.faded), (el) => el.opacity(0.55))
          .children(this.fitThumbs(x.paths).boxes.map((b) => this.shot(t, b).cursor_pointer()));
        return col(x.title ? v_flex().w_full().gap(4).child(row).child(div().w_full().truncate().text_size(12).text_color(t.dim).child(x.title)) : row, 18, 4);
      }
      case "agent":
        return pad(theirs(x.text));
      case "thought":
        // Its thinking, written out: Claude Code's narration between steps, which its terminal
        // shows as messages (and the log keeps only as thinking). Never a turn's last reply.
        return pad(div().w_full().child(TextView.markdown(`${pre}chat-th-${x.id}`, this.findMark(x.text) || " ").selectable(true)));
      case "gallery": {
        // Pictures a tool returned (screens from Mobbin, say): as many as fit across, the last
        // marked "+N" when there are more; a click opens one large, the rest to step through
        // (clickRow(): rows take no handlers or scroll areas of their own, or the list draws blank).
        const { boxes, more } = this.galleryBoxes(x);
        return col(h_flex().w_full().h(GALLERY_H).gap(THUMB_GAP).children(boxes.map((b, i) => this.shot(t, b)
          .when(more > 0 && i === boxes.length - 1, (el) => el.child(h_flex().absolute().inset_0().rounded(8).items_center().justify_center()
            .bg("#000000a0").text_size(15).font_semibold().text_color("#ffffff").child(`+${more}`))))), 18, 4);
      }
      case "diff": {
        // An edit (log.js diffOf()): "Edited <file> +N −M" over its lines, red and green, open
        // until its header is clicked shut (clickRow(); opened here means shut).
        const shut = this.opened.has(x.id);
        const shown = x.lines.slice(0, DIFF_SHOWN), left = x.lines.length - shown.length + (x.more ?? 0);
        const tint = (l) => (l.t === "+" ? green() : l.t === "-" ? red() : null);
        const line = (l) => (l.t === "@"
          ? div().h(18).px(10).text_color(t.dim).child("⋯")
          // Long lines wrap, as Codex's do (the measurer takes each card's drawn height).
          : h_flex().min_h(18).items_start().when(Boolean(tint(l)), (el) => el.bg(tint(l) + "24"))
            .child(div().w(20).h(18).flex_none().text_center().text_color(tint(l) ?? t.dim).child(l.t === " " ? "" : l.t === "-" ? "−" : "+"))
            .child(div().flex_1().min_w(0).pr(10).whitespace_normal().text_color(t.foreground).child(l.s || " ")));
        return col(v_flex().w_full().gap(6)
          .child(h_flex().h(20).gap(6).items_center().cursor_pointer().text_size(12.5).text_color(t.dim).hover((s) => s.text_color(t.muted))
            .child(div().flex_none().child("Edited"))
            .child(div().flex_none().font_medium().text_color(t.foreground).child(fileName(x.file)))
            .when(x.add > 0, (el) => el.child(div().flex_none().text_color(green()).child(`+${x.add}`)))
            .when(x.del > 0, (el) => el.child(div().flex_none().text_color(red()).child(`−${x.del}`)))
            .child(svg(`mods/workspace-chrome/chevron-${shut ? "right" : "down"}.svg`).size(12).flex_none()))
          .when(!shut, (el) => el.child(v_flex().w_full().py(4).rounded(8).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
            .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
            .children(shown.map(line))
            .when(left > 0, (el) => el.child(div().h(18).px(10).text_color(t.dim).child(`${left} more line${left === 1 ? "" : "s"}`))))), 18, 4);
      }
      case "worked": {
        // A finished turn's work, folded (foldTurns()): opens on a click (clickRow()).
        const open = this.opened.has(x.id);
        return col(v_flex().w_full().gap(8)
          .child(h_flex().h(20).gap(4).items_center().cursor_pointer().text_size(12.5).text_color(t.dim).hover((s) => s.text_color(t.muted))
            .child(x.secs != null ? `Worked for ${duration(x.secs)}` : "Worked")
            .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none()))
          .child(div().w_full().h(1).bg(t.border)), 18, 6);
      }
      case "codehead": {
        const done = this.copied === x.id;
        return col(h_flex().w_full().h(28).pl(12).pr(4).items_center().rounded_t(8).bg(t.surface).border_1().border_b(0).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(x.lang || "code"))
          .child(h_flex().h(22).px(6).gap(5).items_center().rounded(6).cursor_pointer().text_size(12).text_color(done ? t.foreground : t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .child(svg(`mods/chat/${done ? "check" : "copy"}.svg`).size(12).flex_none()).child(done ? "Copied" : "Copy")), 18, 0).pt(x.top0 ? 0 : 6);
      }
      case "code": {
        const lines = v_flex().w_full().flex_none().children(x.code.split("\n").map((l) => div().min_h(19).child(l || " ")));
        return col(div().w_full().px(12).py(8).rounded_b(8).bg(t.surface).border_1().border_color(t.border).overflow_hidden()
          .font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5).text_color(t.foreground)
          .child(x.clip ? this.clipped(t.surface, x.clip, lines) : lines), 18, 0).pb(x.bot0 ? 0 : 6);
      }
      case "fold":
        // Show more / Show less, under the reply, in line with its words (clickRow()).
        return col(h_flex().w_full().h(22).child(h_flex().h(22).gap(4).items_center().cursor_pointer()
          .text_size(12.5).font_medium().text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .child(x.open ? "Show less" : "Show more")
          .child(svg(`mods/chat/chevron-${x.open ? "up" : "down"}.svg`).size(14).flex_none())), 18, 2);
      case "day":
        return col(div().w_full().text_center().text_size(12).font_medium().text_color(t.dim).child(x.text), 18, 0);
      case "cardstrip":
        // One strip of a card waiting on the person (strips.js): its presses come through
        // clickRow(), by where they were.
        return col(strips.strip(t, x.s, x.first, x.last, pre), 18, 0);
      case "askend":
        // A closed ask: what it asked and how it went, quiet (the card itself is gone).
        return col(h_flex().w_full().py(QUIET_PY).gap(6).items_center().text_size(12).text_color(t.dim)
          .child(svg("mods/chat/check.svg").size(12).flex_none())
          .child(div().min_w(0).truncate().child(x.text)), 18, 0);
      case "artifact": {
        const icon = (n) => svg("mods/artifacts/artifacts.svg").size(n).flex_none();
        // A "Published" line opens its artifact (clickRow): the pointer and a hover say so.
        if (x.pending || x.line) return col(h_flex().w_full().py(QUIET_PY).gap(6).items_center().text_size(12).text_color(t.dim).child(icon(12))
          .when(Boolean(x.art) && !x.pending, (el) => el.rounded(8).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.muted)))
          .child(div().min_w(0).truncate().child(x.pending ? "Publishing an artifact…" : `Published ${x.title} v${x.v}`)), 18, 0);
        // The whole card opens it (rows take no handlers; clickRow).
        return pad(h_flex().w_full().max_w(420).gap(10).items_center().px(10).py(8).rounded(10).cursor_pointer()
          .bg(t.surface).border_1().border_color(t.border).hover((s) => s.bg(t.hover))
          .child(div().size(32).flex_none().flex().items_center().justify_center().rounded(8).bg(t.raised).text_color(t.muted).child(icon(16)))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().font_medium().text_color(t.foreground).truncate().child(x.title))
            .child(div().text_size(12).text_color(t.dim).child(`Artifact · v${x.version}`)))
          .child(h_flex().h(28).px(10).flex_none().items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
            .text_size(12.5).font_medium().text_color(t.foreground).child("Open")));
      }
      case "ask":
        // Red while its dialog is open; once it's gone (answered, or closed without an answer), calm.
        return pad(v_flex().w_full().gap(4).px(12).py(10).rounded(10).border_1().border_color(t.border)
          .child(div().text_size(12).font_medium().text_color(x.closed ? t.dim : t.blocked)
            .child(x.closed === "answered" ? "Asked you · Answered" : x.closed ? "Asked you · Closed without an answer" : "Asked you"))
          .child(div().text_color(x.closed ? t.muted : t.foreground).child(TextView.markdown(`${pre}chat-md-${x.id}`, x.text).selectable(true))));
      case "error":
        return pad(div().w_full().text_size(12.5).text_color(t.blocked).child(x.text));
      case "tools": {
        const open = this.opened.has(x.id);
        return col(v_flex().w_full().px(6).py(QUIET_PY).rounded(7).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
            .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none())
            .child(div().flex_1().min_w(0).truncate().child(summary(x.steps))))
          .when(open, (el) => el.child(v_flex().pl(18).pt(4).pb(2).gap(3).text_size(12).text_color(t.muted)
            .children(x.steps.flatMap((s) => {
              // Commands and what they printed in the terminal's font, as code is.
              const out = this.results.get(s.id), mono = settings().font_family ?? "JetBrains Mono";
              // A command: its description, then the command itself ("Ran" when it has none).
              const part = (line) => (s.cmd && !line.includes("\n") ? [s.label, s.cmd] : s.kind === "run" && line.startsWith("Ran ") ? ["Ran", line.slice(4)] : [line, null]);
              // On two lines, for reading: what it's for, then the command.
              return [...s.line.split("\n").map((line) => { const [label, code] = part(line); return v_flex().min_w(0).gap(1)
                .child(div().truncate().child(label))
                .when(Boolean(code), (el) => el.child(div().truncate().font_family(mono).text_size(11.5).text_color(t.dim).child(code))); }),
                ...(out ? [v_flex().ml(2).mb(3).pl(8).border_l(1).border_color(t.border).font_family(mono).text_size(11).text_color(t.dim)
                  .children(out.split("\n").map((l) => div().truncate().child(l || " ")))] : [])];
            })))), 12, 0);
      }
    }
    return div();
  }

  // A folded reply's first `h` px of `el`, fading out into `bg` (its bubble's color).
  clipped(bg, h, el) {
    const fade = [0.3, 0.55, 0.8, 0.95];
    return div().relative().w_full().max_h(h).overflow_hidden().child(el)
      .child(v_flex().absolute().left(0).right(0).bottom(0).children(fade.map((o) => div().w_full().h(8).bg(bg).opacity(o))));
  }

  // A press on a row: open a tools row, copy a code block, or a message action.
  clickRow(key, rows, cx, sizes) {
    const row = rows.find((r) => r.id === key);
    if (!row) return;
    const bar = this.hitBar(row);
    if (bar) { this.act(row.bar, bar, cx); cx.notify(); return; }
    if (row.kind === "tools") {
      if (this.opened.has(key)) this.opened.delete(key);
      else { this.opened.add(key); this.loadResults(row, cx); }
    } else if (row.kind === "codehead") this.copy(row.code, row.id, cx);
    // A message of yours with annotations: what they quoted, opened and shut.
    else if (row.kind === "user" && row.noteItems?.length) { const k = `n:${row.id}`; if (this.opened.has(k)) this.opened.delete(k); else this.opened.add(k); }
    else if (row.kind === "pending" && row.failed) { const p = this.pending.find((x) => x.id === row.id); if (p?.msg) this.retry(p, cx); }
    else if (row.kind === "artifact" && row.art) this.openArtifact(row);
    else if (row.kind === "cardstrip") {
      // Which of the strip's controls the press was on (rows take no handlers: strips.js hit()).
      const c = strips.hit(row.s, this.press?.x, strips.innerOf(this.edges()), this.cardW);
      if (row.ask) row.owner?.pressed(row.ask);
      if (c?.kind === "input") (c.state ?? null)?.focus();
      else c?.fn?.(cx);
    }
    else if (row.kind === "brief" || row.kind === "worked" || row.kind === "diff") { if (this.opened.has(key)) this.opened.delete(key); else this.opened.add(key); }
    else if (row.kind === "fold") {
      // Only on its words (as rowBare() draws them: the column's edge, the bubble's padding in).
      const off = (this.press?.x ?? -1) - this.edges().left;
      if (off >= -4 && off <= 100) this.toggleFold(row, rows);
    }
    else if (row.kind === "replyref") {
      this.goTo(row.to, row.of, rows);
      // The light goes out natively: its target flips once, the transition does the rest.
      cx.timer.after(80, (cx) => { if (this.flash) { this.flash.on = false; cx.notify(); } });
      cx.timer.after(1400, (cx) => { this.flash = null; cx.notify(); });
    }
    else if (row.kind === "gallery") {
      // Which picture the press was on: the strip starts at the column's edge.
      const { boxes, paths } = this.galleryBoxes(row);
      const off = (this.press?.x ?? -1) - this.edges().left;
      for (let i = 0, edge = 0; i < boxes.length && off >= 0; edge += boxes[i].w + THUMB_GAP, i++)
        if (off >= edge && off <= edge + boxes[i].w) { this.openImages(paths, i); break; }
    }
    else if (row.kind === "imgs") {
      // Which thumbnail the press was on (rows take no handlers of their own): the person's are
      // right-aligned, the agent's left-aligned.
      const x = this.press?.x;
      const boxes = this.fitThumbs(row.paths).boxes;
      const open = (i) => (this.views[row.paths[i]]?.video ? exec("open", [row.paths[i]]) : this.openImages(row.paths.filter((p) => !this.views[p]?.video), row.paths.filter((p) => !this.views[p]?.video).indexOf(row.paths[i])));
      if (row.side === "agent") {
        const off = x === undefined ? -1 : x - this.edges().left;
        for (let i = 0, edge = 0; i < boxes.length && off >= 0; edge += boxes[i].w + THUMB_GAP, i++)
          if (off >= edge && off <= edge + boxes[i].w) { open(i); break; }
      } else {
        const off = x === undefined ? -1 : this.edges().right - x;
        for (let i = boxes.length - 1, edge = 0; i >= 0 && off >= 0; edge += boxes[i].w + THUMB_GAP, i--)
          if (off >= edge && off <= edge + boxes[i].w) { open(i); break; }
      }
    }
    cx.notify();
  }

  // What the agent says it waits for (its status report), e.g. "Do you prefer tea or coffee? (Tea · Coffee)".
  asking() {
    const msg = terminals().find((x) => x.address === this.addr)?.report?.msg;
    return typeof msg === "string" && msg.trim() ? msg.replace(/^answer:\s*/i, "").trim() : null;
  }

  // ---- what sits under the conversation -----------------------------------------------------

  statusLine(t, st) {
    // A card asks (in the timeline, where it appeared): nothing under the conversation repeats it.
    if (this.asks.length || (this.addr && openCard(this.addr))) return null;
    if (st === "working") {
      // What it is doing, in plain words, for how long, and Stop. The line has the composer box's
      // edges (same width and padding), so Stop's right edge is the box's.
      const secs = Math.max(0, Math.floor((Date.now() - (this.workingSince ?? Date.now())) / 1000));
      const report = terminals().find((x) => x.address === this.addr)?.report?.msg;
      const doing = this.stopping ? "Stopping…"
        : this.conv?.doing ?? (typeof report === "string" && report.trim() && !/^answer:/i.test(report) ? report.trim() : "Working");
      // Only waiting (hc wait, a sleep, a monitor, a helper it waits on): calm, no spinner; a
      // message wakes it (or comes in at once).
      const waiting = this.waitingNow() && !this.stopping;
      return h_flex().id("chat-status").flex_none().w_full().max_w(COLUMN + 28).mx_auto().h(30).px(14).gap(8).items_center().text_size(12).text_color(t.muted)
        .when(waiting, (el) => el.child(svg("mods/chat/clock.svg").size(12).flex_none().text_color(t.dim)))
        .when(!waiting, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .child(div().flex_1().min_w(0).truncate().child(doing))
        .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5).text_color(t.dim)
          .child(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`))
        .child(h_flex().id("chat-stop").h(22).px(8).gap(6).flex_none().items_center().rounded(6).border_1().border_color(t.input)
          .text_size(12).text_color(t.muted)
          .when(this.stopping, (el) => el.opacity(0.45))
          .when(!this.stopping, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.stop(cx); }))
          .child(svg("mods/chat/stop-chip.svg").size(8).flex_none())
          .child(div().child("Stop"))
          .child(div().text_size(11).text_color(t.dim).child("Esc")));
    }
    if (st === "blocked") {
      return div().flex_none().w_full().max_w(COLUMN + 28).mx_auto().px(14).pt(6).child(h_flex().px(12).py(10).gap(10).items_center().rounded(10)
        .bg(t.surface).border_1().border_color(t.border)
        .child(div().size(8).flex_none().rounded(4).bg(t.blocked))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().font_medium().text_color(t.foreground).child("Needs you"))
          .child(div().text_size(12).text_color(t.muted).child(this.asking() ?? "The agent is asking something in the terminal.")))
        .child(this.button("chat-open-terminal", "Open terminal", "mods/workspace-chrome/terminal.svg", "primary", t, () => this.toTerminal())));
    }
    return null;
  }

  // The agent's helpers that are busy: its CLI's own (Claude Code's helpers launched and not
  // finished, Codex's spawned agents) count as working; Herdr's (terminals it started with hc:
  // their parent is this agent) count when they report working or blocked. Idle or finished
  // helpers, and programs that report nothing, don't count.
  helpers() {
    // Only the CLI's own subagents (Claude Code's Agent/Task runs, Codex's spawned agents), from
    // its log. Agents it started with hc are terminals Herdr already lists under it in the
    // Agents sidebar, so they aren't repeated here.
    return (this.conv?.running?.() ?? []).map((h) => ({ id: h.id, label: h.desc, at: h.at }));
  }

  // A Claude Code helper's own log: <session>/subagents/agent-<id>.jsonl, the one whose
  // .meta.json names the call that started it. Opened read-only in a dialog over the window.
  // Its running helpers for the Agents panel (agents-sandbox lists them under the agent), as
  // shared "chat.subagents": { <agent address>: { log, machine, list: [{ id, label, at }] } }.
  // The panel opens one with this chat's transcript props, finding its log as openHelper() does.
  publishHelpers() {
    if (this.transcript || !this.addr) return;
    const all = shared("chat.subagents") ?? {};
    const list = this.kind === "claude" && this.path ? this.helpers().map((h) => ({ id: h.id, label: h.label, at: h.at ?? null })) : [];
    const mine = list.length ? { log: this.path, machine: this.machine, list } : null;
    if (JSON.stringify(mine) === JSON.stringify(all[this.addr] ?? null)) return;
    const next = { ...all };
    if (mine) next[this.addr] = mine; else delete next[this.addr];
    setShared("chat.subagents", next);
  }

  openHelper(h) {
    if (!this.path || this.kind !== "claude" || !h.id) return;
    const dir = `${this.path.replace(/\.jsonl$/, "")}/subagents`;
    exec("sh", ["-c", 'f=$(grep -lF -e "$2" "$1"/*.meta.json 2>/dev/null | head -1); [ -n "$f" ] && printf %s "${f%.meta.json}.jsonl"', "x", dir, `"toolUseId":"${h.id}"`], { on: this.machine })
      .then((r) => {
        if (!r.stdout) { toast({ title: "No conversation for this helper", body: "Claude Code hasn't written its log yet.", level: "info" }); return; }
        openOverlay({ mod: "chat", kind: "dialog", width: 860, height: 640, props: { transcript: { path: r.stdout, kind: "claude", title: h.label } } });
      }).catch(() => {});
  }

  // Only waiting: its current call is itself a wait (hc wait, a sleep, a monitor, wait_agent, a
  // helper it waits on). Helpers merely existing don't make it wait.
  waitingNow() {
    return Boolean(this.conv?.waiting);
  }

  // Above the box: the CLI's subagents at work, one row each as Claude Code and Codex list them
  // (a spinner, its name, how long). Four rows, then "+N more" opens the rest.
  background(t, st) {
    const now = Date.now();
    const helpers = this.helpers();
    if (!helpers.length) return null;
    const shown = helpers;
    const open = this.helpersOpen || shown.length <= 5;
    const list = open ? shown : shown.slice(0, 4);
    const ago = (at) => {
      if (!at) return "";
      const s = Math.max(0, Math.floor((now - at) / 1000));
      return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
    };
    // A click opens its conversation (openHelper()).
    const row = (h, i) => h_flex().id(`helper-${i}`).w_full().h(24).px(6).gap(8).items_center().text_size(12).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.openHelper(h); })
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(h.label))
      .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5).text_color(t.dim).child(ago(h.at)));
    // A card docked on the box's top edge (as Manus shows its running work), so the helpers read
    // apart from the agent's own working line above: a count that folds it, then a row each.
    const shut = this.helpersShut;
    return v_flex().flex_none().w_full().max_w(COLUMN + 28).mx_auto().px(14).pt(6)
      .child(v_flex().mx(12).px(6).py(4).rounded_t(10).border_1().border_b(0).border_color(t.border).bg(t.surface)
        .child(h_flex().id("helpers-head").h(24).px(6).gap(6).items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.helpersShut = !shut; cx.notify(); })
          .child(div().flex_1().child(`${shown.length} helper${shown.length === 1 ? "" : "s"} running`))
          .child(svg(`mods/chat/chevron-${shut ? "up" : "down"}.svg`).size(12).flex_none()))
        .when(!shut, (el) => el.children(list.map(row))
          .when(!open, (el) => el.child(h_flex().id("helpers-more").h(22).px(6).gap(6).items_center().rounded(6).cursor_pointer()
            .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.helpersOpen = true; cx.notify(); })
            .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).flex_none())
            .child(`+${shown.length - 4} more`)))));
  }

  // Held messages, each with Edit and Cancel; they go once the agent is free.
  queued(t) {
    if (!this.queue.length) return null;
    const ghost = (id, label, fn) => h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(6).cursor_pointer().text_size(12).font_medium()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
      .child(label);
    return v_flex().flex_none().w_full().max_w(COLUMN + 28).mx_auto().px(14).pt(6).gap(4).children(this.queue.map((m) =>
      h_flex().id(`queued-${m.id}`).w_full().h(40).pl(10).pr(4).gap(8).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(svg("mods/chat/clock.svg").size(14).flex_none().text_color(t.dim))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(m.label ?? (m.text || m.files.map((f) => f.name).join(", "))))
          .child(div().truncate().text_size(12).text_color(t.dim).child("Queued · Sends when the agent is free")))
        .child(ghost(`queued-now-${m.id}`, "Send now", (cx) => this.sendQueued(m, cx)))
        .child(ghost(`queued-edit-${m.id}`, "Edit", (cx) => this.editQueued(m, cx)))
        .child(div().id(`queued-x-${m.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.queue = this.queue.filter((x) => x !== m); this.saveSoon(cx); cx.notify(); })
          .child(svg("mods/chat/x.svg").size(12)))));
  }

  // The "/" list: the agent's commands that match what is typed.
  slashList(t, list) {
    if (!list.length) return null;
    const sel = Math.min(this.slashSel, list.length - 1);
    return v_flex().w_full().p(5).border_b(1).border_color(t.border).children(list.map((c, i) =>
      h_flex().id(`slash-${c.name}`).h(28).px(8).gap(9).items_center().rounded(7).cursor_pointer()
        .when(i === sel, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.pick(c, cx); })
        .child(div().flex_none().text_size(12.5).font_medium().text_color(t.foreground).child(c.label ?? c.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(c.about))
        .when(Boolean(c.state), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(c.state)))));
  }

  // Files waiting to go: small tiles above the box, each removable.
  tiles(t) {
    if (!this.files.length && !this.quote && !this.notes.length) return null;
    // One line of its quote, without Markdown's marks (the quote itself keeps them).
    const noteLabel = (n) => { const q = norm(n.quote.value().replace(/[*_`#>]+/g, "").replace(/^\s*[-+] /gm, "")); return n.paths?.length ? `Picture${n.paths.length > 1 ? "s" : ""}${q ? ` · ${q}` : ""}` : q; };
    return v_flex().w_full().px(10).pt(8).gap(6)
      // Annotations: what each points at (a click opens its quote to read and cut down), its
      // comment, and × to drop it.
      .children(this.notes.map((n, i) => v_flex().w_full().rounded(8).bg(t.raised).child(h_flex().id(`note-${i}`).w_full().h(30).pl(8).pr(2).gap(8).items_center()
        .child(svg("mods/chat/annotate.svg").size(13).flex_none().text_color(t.muted))
        .child(h_flex().id(`note-open-${i}`).flex_1().min_w(0).gap(4).items_center().cursor_pointer().text_size(12).text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); n.open = !n.open; if (n.open) n.quote.focus(); cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().child(noteLabel(n)))
          .child(svg(`mods/workspace-chrome/chevron-${n.open ? "down" : "right"}.svg`).size(12).flex_none()))
        .child(div().w(220).flex_none().child(Input.new(n.comment).w_full().text_size(12).text_color(t.foreground)))
        .child(div().id(`note-x-${i}`).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.notes = this.notes.filter((x) => x !== n); cx.notify(); })
          .child(svg("mods/chat/x.svg").size(12))))
        .when(n.open, (el) => el.child(div().w_full().px(8).pb(8)
          .child(Textarea.new(n.quote).w_full().text_size(12).text_color(t.foreground))))))
      .when(Boolean(this.quote), (el) => el.child(h_flex().w_full().h(24).pl(4).gap(6).items_center()
        .child(svg("mods/chat/reply.svg").size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(norm(this.quote.text)))
        .child(div().id("quote-x").size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.quote = null; this.saveSoon(cx); cx.notify(); })
          .child(svg("mods/chat/x.svg").size(12)))))
      .when(this.files.length > 0, (el) => el.child(div().flex().flex_wrap().gap(8).pt(2).children(this.files.map((f, i) => {
        const imgs = this.files.filter((x) => x.image).map((x) => x.path);
        const tile = f.image
          ? this.thumb(t, f.path).id(`file-${i}`).cursor_pointer()
            .on_click((_e, cx) => { cx.stop_propagation(); this.openImages(imgs, imgs.indexOf(f.path)); })
          // Not an image: a tile of the same size with its icon and a short name.
          : v_flex().id(`file-${i}`).size(THUMB).flex_none().px(4).gap(3).items_center().justify_center().rounded(8)
            .border_1().border_color(t.border).bg(t.surface)
            // A pasted text opens to read.
            .when(Boolean(f.text), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.openText(f); }))
            .child(svg("mods/chat/file.svg").size(16).flex_none().text_color(t.dim))
            .child(div().w_full().text_center().truncate().text_size(10.5).text_color(t.muted).child(f.name));
        return div().relative().flex_none().child(tile)
          .child(div().id(`file-x-${i}`).absolute().top(-6).right(-6).size(18).flex().items_center().justify_center().rounded(9).cursor_pointer()
            .bg(t.popover).border_1().border_color(t.border).text_color(t.muted).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); attach.drop(f); this.files = this.files.filter((x) => x !== f); this.saveSoon(cx); cx.notify(); })
            .child(svg("mods/chat/x.svg").size(10)));
      }))));
  }

  // An image as a THUMB-sized square, cropped to fill it (attach.cover); a quiet square until its
  // size is known (needViews).
  thumb(t, path) {
    const v = this.views[path];
    const box = div().relative().size(THUMB).flex_none().rounded(8).overflow_hidden().bg(t.raised);
    const edge = div().absolute().inset_0().rounded(8).border_1().border_color(t.foreground + "1a");
    if (!v) return box.child(edge);
    const c = attach.cover(v.w, v.h, THUMB);
    return box.child(image(v.rel).absolute().left(c.left).top(c.top).w(c.w).h(c.h)).child(edge);
  }

  // Thumbnails under a message: each image whole, its shape kept, fitted in THUMB_ONE or
  // THUMB_MANY, never above its own size, all shrunk together when the row would pass the
  // column. A quiet box until its size is known. { boxes: [{ path, w, h }], h: the row's height }.
  fitThumbs(paths) {
    const [mw, mh] = paths.length > 1 ? THUMB_MANY : THUMB_ONE;
    let boxes = paths.map((path) => {
      const v = this.views[path];
      if (!v) return { path, w: Math.round(mh * 4 / 3), h: mh };
      const k = Math.min(1, mw / v.w, mh / v.h);
      return { path, w: Math.max(24, Math.round(v.w * k)), h: Math.max(24, Math.round(v.h * k)) };
    });
    const { left, right } = this.edges();
    const total = boxes.reduce((n, b) => n + b.w, 0) + THUMB_GAP * (boxes.length - 1);
    const k = Math.min(1, (right - left) / Math.max(1, total));
    if (k < 1) boxes = boxes.map((b) => ({ ...b, w: Math.floor(b.w * k), h: Math.floor(b.h * k) }));
    return { boxes, h: Math.max(24, ...boxes.map((b) => b.h)) };
  }

  // A gallery row's pictures (case "gallery"): GALLERY_H tall, as wide as their shape, as many as
  // fit the column; more: how many didn't. A path that isn't a picture here drops out once looked at.
  galleryBoxes(row) {
    const { left, right } = this.edges();
    const paths = row.paths.filter((p) => this.views[p] || !this.viewAsked.has(p));
    const boxes = [];
    let used = 0;
    for (const path of paths) {
      const v = this.views[path];
      const w = Math.min(420, Math.round(GALLERY_H * (v ? v.w / v.h : 4 / 3)));
      if (boxes.length && used + THUMB_GAP + w > right - left) break;
      boxes.push({ path, w, h: GALLERY_H });
      used += (boxes.length > 1 ? THUMB_GAP : 0) + w;
    }
    return { boxes, more: paths.length - boxes.length, paths };
  }

  // One of those: the whole image, rounded, a faint edge drawn over it.
  shot(t, b) {
    const v = this.views[b.path];
    return div().relative().w(b.w).h(b.h).flex_none().rounded(8).overflow_hidden().bg(t.raised)
      .when(Boolean(v), (el) => el.child(image(v.rel).size_full()))
      // A video's first frame, with a play mark: it opens in the system's player.
      .when(Boolean(v?.video), (el) => el.child(h_flex().absolute().inset_0().items_center().justify_center()
        .child(h_flex().size(40).rounded(20).items_center().justify_center().bg("#000000a0").text_color("#ffffff").child(svg("mods/chat/play.svg").size(18)))))
      .child(div().absolute().inset_0().rounded(8).border_1().border_color(t.foreground + "1a"));
  }

  // The images the chat shows, linked where image() can load them, with their sizes. Asked once each.
  needViews(paths, cx) {
    const want = [...new Set(paths)].filter((p) => p && !this.views[p] && !this.viewAsked.has(p));
    if (!want.length) return;
    for (const p of want) this.viewAsked.add(p);
    // Asked from render: start it right after.
    cx.timer.after(0, (cx) => cx.spawn(async (cx) => {
      Object.assign(this.views, await attach.viewable(want));
      cx.notify();
    }));
  }

  // This chat pane in the window ({ x, y, width, height }), from the press that opens something
  // over it (the viewers: images, text, artifacts); null before any press.
  paneArea() {
    const p = this.pressWin, local = this.press;
    if (!p || local?.x === undefined) return null;
    return { x: p.x - local.x, y: p.y - (local.y ?? 0), width: Math.round(this.width), height: Math.round(this.height ?? 700) };
  }

  // A pasted text file in the viewer (mods/chat-image), over this chat pane.
  openText(f) {
    const a = this.paneArea();
    const at = a ? { x: a.x, y: a.y } : "pointer";
    const width = Math.round(this.width), height = Math.round(this.height ?? 700);
    openOverlay({ mod: "chat-image", kind: "popup", frame: "none", width, height, at, props: { textPath: f.path, title: f.name, width, height } });
  }

  // The viewer (mods/chat-image) on these images, from the i-th.
  openImages(paths, i) {
    const all = paths.map((p) => this.views[p] ? { ...this.views[p], name: p.split("/").pop(), path: p } : null);
    const images = all.filter(Boolean);
    if (!images.length) return;
    i = images.indexOf(all[i] ?? images[0]);
    // Over this chat pane, at its size (a popup's root needs its size spelled out).
    const a = this.paneArea();
    const at = a ? { x: a.x, y: a.y } : "pointer";
    const width = Math.round(this.width), height = Math.round(this.height ?? 700);
    openOverlay({ mod: "chat-image", kind: "popup", frame: "none", width, height, at,
      props: { images, index: Math.max(0, Math.min(images.length - 1, i)), width, height } });
  }

  // The box's height. A hidden copy of the words at the box's width (composer()) says how many
  // rows they take; the textarea gets one row more than that, the spare one tucked under the
  // toolbar, so its words never overflow it: no scrollbar and no nudge while they fit (8
  // rows). Past 8 it shows 8 and scrolls, with its bar. A taller box shortens the list above
  // it, so the list goes back to its end the same frame when it was following the newest.
  sizeBox() {
    const rows = this.lineH && this.textH ? Math.max(1, Math.round(this.textH / this.lineH)) : 1;
    const want = Math.min(rows, 8);
    const spare = Boolean(this.lineH) && rows <= 8;
    const key = `${want}|${spare}`;
    if (key === this.boxKey) return;
    this.boxKey = key;
    this.boxRows = want;
    this.boxSpare = spare;
    this.box.set_rows(spare ? want + 1 : want);
    if (this.pinned) this.stick = true;
  }

  // The desktop's own file picker (pick-files.py, xdg-desktop-portal): the chosen files join
  // the message as tiles, as a drop or a paste makes them.
  pickFiles(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'P=/usr/bin/python3; [ -x "$P" ] || P=python3; exec "$P" -I "$1"', "x", `${appHome()}/mods/chat/pick-files.py`]).catch(() => null);
      const list = (r?.stdout ?? "").split("\n").filter(Boolean);
      if (r && r.code !== 0) this.error = "Couldn't open the file picker.";
      if (!list.length) { cx.notify(); return; }
      this.addFiles(attach.paths(list));
      this.saveSoon(cx);
      this.box.focus();
      cx.notify();
    });
  }

  // The composer's round buttons: one size and shape, so Attach and Send never change size or
  // move; only the icon and fill change.
  //   fill: "solid" (Send), "ghost", "off"
  round(id, icon, t, fill, fn) {
    const el = div().id(id).size(ROUND).flex_none().flex().items_center().justify_center().rounded(ROUND / 2)
      .when(fill === "solid", (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(fill === "off", (el) => el.bg(t.raised).text_color(t.dim))
      .when(fill === "ghost", (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .child(svg(icon).size(14));
    if (!fn) return el;
    return el.cursor_pointer().when(fill !== "ghost", (el) => el.hover((s) => s.opacity(0.85)))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); });
  }

  // The bottom row's model button: what the agent runs on (opens the picker).
  pickButton(t) {
    const c = this.current();
    // Sized to its words, never cut: a narrow chat drops "· 1M" first.
    const model = String(c?.label ?? agent.modelName(c?.model) ?? "");
    const pick = [(this.width ?? 600) < 460 ? model.replace(/\s*·?\s*1M$/, "") : model, agent.levelName(c?.effort), c?.fast ? "Fast" : null].filter(Boolean).join(" · ") || agent.NAMES[this.kind] || "Agent";
    return h_flex().id("chat-agent-pick").h(ROUND).pl(8).pr(5).gap(4).flex_none().items_center().rounded(6)
      .text_size(12).font_medium().text_color(t.muted)
      .cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (e) => { this.pickAt = e.position; })
      .on_click((_e, cx) => { cx.stop_propagation(); this.openPicker(this.pickAt, cx); })
      .child(div().flex_none().whitespace_nowrap().child(pick))
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).flex_none());
  }

  composer(t, st) {
    if (this.transcript) return div().flex_none().w_full().max_w(COLUMN + 28).mx_auto().px(14).pt(8)
      .child(h_flex().w_full().h(36).px(12).gap(8).items_center().rounded(10).border_1().border_color(t.border).text_size(12.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`${this.transcript.title} · a helper's conversation, read-only`))
        .child(this.button("chat-close", "Close", null, "secondary", t, () => closeOverlay(props().overlay))));
    // An open card, or the agent's own dialog in its terminal, doesn't lock the box: words
    // written there answer it ("Reply instead…").
    const ready = this.phase === "ready";
    const empty = !this.box.value().trim() && !this.files.length;
    const can = ready && !empty;
    const list = this.focused || this.paneFocused ? this.suggestions() : [];
    const recallable = !list.length && (!this.box.value() || this.recall >= 0);
    const take = (fn) => (_e, cx) => { fn(cx); cx.stop_propagation(); cx.notify(); };
    const sel = Math.min(this.slashSel, Math.max(0, list.length - 1));
    // Flush under the helpers' card when it shows (background()).
    return div().flex_none().w_full().max_w(COLUMN + 28).mx_auto().px(14).pt(this.helpers().length ? 0 : 8).child(v_flex().id("chat-composer").w_full().rounded(10).border_1()
      // Esc stops a working agent while the box is empty and nothing is open over it.
      .key_context([list.length ? "chat_slash" : recallable ? "chat_recall" : "chat_composer",
        st === "working" && !list.length && !this.box.value().trim() && !this.quote ? "chat_stop" : null].filter(Boolean).join(" "))
      .on_action("chat_stop", take((cx) => this.stop(cx)))
      .on_action("chat_slash_up", take(() => { this.slashSel = (sel + list.length - 1) % list.length; }))
      .on_action("chat_slash_down", take(() => { this.slashSel = (sel + 1) % list.length; }))
      .on_action("chat_slash_take", take((cx) => this.pick(list[sel], cx)))
      .on_action("chat_slash_close", take(() => { this.slashOff = this.box.value().replace(/\n+$/, ""); }))
      .on_action("chat_recall_up", take(() => this.recallStep(1)))
      .on_action("chat_recall_down", take(() => this.recallStep(-1)))
      .on_key_down((e, cx) => {
        const k = e.key, m = e.modifiers ?? {};
        // The "/" list: Up and Down choose, Tab or Enter takes one, Escape closes it.
        if (list.length) {
          const sel = Math.min(this.slashSel, list.length - 1);
          if (k === "down" || k === "up") { this.slashSel = (sel + (k === "down" ? 1 : list.length - 1)) % list.length; cx.stop_propagation(); cx.notify(); return; }
          if (k === "tab") { cx.stop_propagation(); this.pick(list[sel], cx); return; }
          if (k === "escape") { this.slashOff = this.box.value().replace(/\n+$/, ""); cx.stop_propagation(); cx.notify(); return; }
        }
        // Up in an empty box: earlier messages; Down: back again.
        if ((k === "up" && (!this.box.value() || this.recall >= 0)) || (k === "down" && this.recall >= 0)) {
          if (this.recallStep(k === "up" ? 1 : -1)) { cx.stop_propagation(); cx.notify(); }
          return;
        }
        if (k === "escape" && this.quote) { this.quote = null; cx.stop_propagation(); cx.notify(); return; }
        // Enter sends, before the textarea makes it a new line; Shift+Enter stays a new line.
        if (k !== "enter" || m.shift) return;
        cx.stop_propagation();
        this.enter(cx, Boolean(m.control || m.platform));
      })
      .on_drop((e, cx) => { this.addFiles(attach.paths(e.paths ?? [])); this.saveSoon(cx); this.box.focus(); cx.notify(); })
      // Where the box is in the window, for a typed /model's picker (modelCommand()).
      .on_mouse_move((e) => { if (e.bounds) this.composerAt = e.bounds; })
      .border_color(this.focused ? t.accent : t.input).bg(t.background)
      .child(this.slashList(t, list) ?? div())
      .child(this.tiles(t) ?? div())
      // The padding is around the textarea, not on it: its own height is then exactly its rows
      // (auto-grow, 1 to 8), so it never overflows itself by the padding, which showed a
      // scrollbar in an empty box and made it scroll a few pixels on each new line.
      .child(div().relative().w_full().min_h(TEXT_ROW).px(12).pt(9).pb(4)
        // Measured, unseen: a line's height, and the words' height at the box's width (sizeBox()).
        .child(div().id("chat-line-h").absolute().top(0).left(0).opacity(0).text_size(13).child("Xg")
          .on_size_change((size, cx) => { if (Math.abs((this.lineH ?? 0) - size.height) > 0.1) { this.lineH = size.height; this.sizeBox(); cx.notify(); } }))
        .child(div().absolute().top(0).left(12).right(12).h(0).overflow_hidden().opacity(0)
          .child(div().id("chat-text-h").w_full().text_size(13)
            .child(/\n$/.test(this.box.value()) || !this.box.value() ? `${this.box.value()} ` : this.box.value())
            .on_size_change((size, cx) => { if (Math.abs((this.textH ?? 0) - size.height) > 0.1) { this.textH = size.height; this.sizeBox(); cx.notify(); } })))
        .child(Textarea.new(this.box).w_full().text_size(13).text_color(t.foreground)
          .when(Boolean(this.boxSpare && this.lineH), (el) => el.mb(-this.lineH)))
        .when(!this.box.value().trim(), (el) => el.child(div().absolute().top(9).left(12).text_size(13).text_color(t.dim)
          .child(this.asks.length || st === "blocked" ? "Reply instead…" : this.placeholder()))))
      // One row: Attach on the left; on the right what the agent runs on (opens the picker) and
      // Send. Send never turns into Stop: while the agent works it still sends (or queues); Stop
      // is on the working line above.
      .child(h_flex().h(36).pl(6).pr(6).gap(4).items_center()
        // Attach on the left, as ChatGPT and Claude have it: the desktop's file picker.
        .child(this.round("chat-attach", "mods/chat/paperclip.svg", t, "ghost", (cx) => this.pickFiles(cx)).tooltip("Attach files"))
        .child(div().flex_1().min_w(0))
        .when(Boolean(this.addr), (el) => el.child(this.pickButton(t)))
        .child(this.round("chat-send", "mods/chat/send.svg", t, can ? "solid" : "off", can ? (cx) => this.send(cx) : null))));
  }

  // ---- alerts ---------------------------------------------------------------------------------

  // While its terminal is parked behind this chat, Herdr doesn't see the agent: no sound, no
  // toast. So this does what Herdr does: a sound when it needs the person, or finished while
  // they weren't looking, and a toast unless they're looking; and looking marks done as seen.
  alerts(cx) {
    const k = terminals().find((x) => x.address === this.addr);
    const st = k?.status ?? null;
    const mine = this.myPane();
    const parked = Boolean(k) && !panes().some((p) => p.terminal === this.addr);
    const looking = Boolean(mine) && focused()?.pane === mine && window()?.active;
    if (parked && looking && st === "done") {
      const seen = shared("chat.seen") ?? {};
      if (seen[this.addr] !== k.turn) setShared("chat.seen", { ...seen, [this.addr]: k.turn });
    }
    const before = this.lastStatus;
    this.lastStatus = st;
    if (!parked || before === undefined || before === st || !mine) return;
    if (st !== "blocked" && !(st === "done" && !looking)) return;
    if (settings()?.sounds?.enabled !== false) playSound(st);
    if (looking) return;
    const tab = panes().find((p) => p.pane === mine)?.tab;
    toast({
      title: `${toastWho(k)} · ${st === "blocked" ? "Needs you" : "Finished"}`,
      body: (st === "blocked" ? this.asking() : null) ?? k.title ?? "",
      level: st === "blocked" ? "alert" : "success",
      action: tab ? { name: "tab.select", args: { id: tab } } : undefined,
    });
  }

  // ---- artifacts (mods/artifacts) -----------------------------------------------------------

  // Which artifact each publish in the conversation made: the first version this agent
  // published from a few seconds before the call to five minutes after, not already taken.
  // Map item id -> { id, title, version (its latest), v (this publish's), latest }.
  resolveArts(items) {
    const out = new Map();
    const calls = items.filter((x) => x.kind === "artifact");
    if (!calls.length || !this.arts?.length) return out;
    const me = String(this.addr ?? "").split("/").pop();
    const vs = this.arts.flatMap((a) => (a.versions ?? []).filter((v) => v.publisher === me).map((v) => ({ a, v }))).sort((p, q) => p.v.at - q.v.at);
    const used = new Set();
    for (const x of calls) {
      const at = x.at ?? 0;
      const hit = vs.find(({ a, v }) => !used.has(`${a.id}:${v.v}`) && v.at >= at - 5000 && v.at <= at + 300000);
      if (!hit) continue;
      used.add(`${hit.a.id}:${hit.v.v}`);
      out.set(x.id, { id: hit.a.id, title: hit.a.title, version: hit.a.version, v: hit.v.v });
    }
    const last = new Map();
    for (const [k, r] of out) last.set(r.id, k);
    for (const [k, r] of out) r.latest = last.get(r.id) === k;
    return out;
  }

  // Every artifact on the agent's machine (~/.herdr/artifacts, one registry per folder): read
  // when the conversation has a publish, again every few seconds while one isn't listed yet.
  // A folder under a hidden one has a dot slug (~/.config/x: .config-x.json), so dot files
  // count too; locks end in .lock, temp files have no .json.
  loadArts(cx) {
    if (this.artsLoading || Date.now() - (this.artsAt ?? 0) < 3000) return;
    this.artsLoading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", 'cd "$HOME/.herdr/artifacts" 2>/dev/null || exit 0; for f in *.json .*.json; do [ -f "$f" ] && cat "$f" && printf "\\n\\036\\n"; done; true'], this.machine ? { on: this.machine } : {});
        const arts = [];
        for (const part of r.stdout.split("\x1e")) { try { arts.push(...(JSON.parse(part).artifacts ?? [])); } catch {} }
        this.arts = arts;
      } catch {}
      this.artsAt = Date.now();
      this.artsLoading = false;
      cx.notify();
    });
  }

  // An artifact over this chat pane, exactly like an opened image: the image viewer's shell (the
  // person's decision, artview.js). A "Published X v2" line opens v2; the card, the latest.
  openArtifact(row) {
    openViewer({ id: row.art, title: row.title, version: row.line && row.v ? row.v : row.version, latest: row.version, machine: this.machine ?? null }, this.paneArea());
  }

  // This chat's own pane: the agent's core label herdr.chat (set by the pane-sandbox switch).
  myPane() {
    const c = terminals().find((x) => x.address === this.addr)?.labels?.["herdr.chat"] ?? null;
    if (c && panes().some((p) => p.pane === c && p.mod === "chat")) this.lastPane = c;
    return c || (this.swapping ? this.lastPane : null);
  }

  // One copy of Herdr's live lists for the whole render (live.js): a render past Herdr's 50 ms
  // is stopped, and the chat then shows "This view could not be re-rendered".
  render(cx) {
    return inRender(() => this.draw(cx));
  }

  draw(cx) {
    // The pane getting focus (opened, clicked, gone to) puts the keyboard in the message box.
    const mine = this.myPane();
    const paneFocused = Boolean(mine && focused()?.pane === mine);
    // Herdr settles pane focus a moment later, so ask again after it (as the help mod does).
    // The box also comes back after a notice (opening, restarting): it gets the keyboard then too.
    const showsBox = Boolean(this.addr) && this.phase === "ready";
    // Focus moves only outside render: from a timer callback right after it.
    if (paneFocused && showsBox && (!this.wasFocused || !this.hadBox)) { cx.timer.after(0, () => this.box.focus()); cx.timer.after(600, () => this.box.focus()); }
    // The pane focused again (a command, a click on its header) can leave the box without the
    // keyboard: give it back, unless the person just pressed something inside the chat.
    else if (paneFocused && showsBox && this.focused === false && Date.now() - (this.press?.at ?? 0) > 1500
      && Date.now() - (this.refocusAt ?? 0) > 1000) {
      this.refocusAt = Date.now();
      cx.timer.after(0, () => this.box.focus());
    }
    this.wasFocused = paneFocused;
    this.hadBox = showsBox;
    this.paneFocused = paneFocused;
    // The model picker's Restart (mods/chat-models): shared "chat.restartreq" = { pane, at, pick }.
    const rr = shared("chat.restartreq");
    if (rr && mine && rr.pane === mine && rr.at !== this.restartReqAt && Date.now() - rr.at < 5000) {
      this.restartReqAt = rr.at;
      cx.timer.after(0, (cx) => { this.applyPick(rr.pick, cx); cx.notify(); });
    }
    // Another mod sending a message as if typed here: shared "chat.sendreq" = { pane, at, text }.
    const sq = shared("chat.sendreq");
    if (sq && sq.pane === mine && sq.at !== this.sendReqAt && Date.now() - sq.at < 5000 && String(sq.text ?? "").trim()) {
      this.sendReqAt = sq.at;
      cx.timer.after(0, (cx) => { this.deliver({ id: `m${Date.now()}`, text: String(sq.text).trim(), files: [], quote: null }, cx); this.pinned = true; this.stick = true; cx.notify(); });
    }
    // The emoji row's pick (mods/chat-react): shared "chat.reactreq" = { pane, at, target, text, emoji }.
    const rq = shared("chat.reactreq");
    if (rq && rq.pane === mine && rq.at !== this.reactReqAt && Date.now() - rq.at < 5000) {
      this.reactReqAt = rq.at;
      cx.timer.after(0, (cx) => { this.toggleReaction(rq.target, rq.text, rq.emoji, cx); });
    }
    this.alerts(cx);
    const t = theme();
    const st = this.status() ?? null;
    if (st === "working" && this.lastWorking !== "working") this.workingSince = Date.now();
    if (st !== "working") this.stopping = false;
    this.lastWorking = st;
    const root = v_flex().id("chat").size_full().bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) this.width = size.width;
        this.height = size.height;
        if (this.pinned) this.stick = true;
        cx.notify();
      })
      // Where a press was, for the action buttons under messages (rows can't take handlers).
      .on_mouse_down("left", (e) => { this.press = { x: e.local_position?.x, y: e.local_position?.y, at: Date.now() }; this.pressWin = e.position; this.keepIcons = null; })
      // Files dropped anywhere on the chat go with the next message.
      .on_drop((e, cx) => { this.addFiles(attach.paths(e.paths ?? [])); this.saveSoon(cx); this.box.focus(); cx.notify(); });

    if (!this.addr && !this.transcript) return root.child(this.notice(t, "No agent to show", "This chat pane isn't tied to an agent.", [
      this.button("chat-close", "Close", null, "secondary", t, () => this.closeSelf())]));
    if (this.phase === "ended" && !this.swapping) return root.child(this.notice(t, "This agent has ended", null, [
      this.button("chat-close", "Close chat", null, "secondary", t, () => this.closeSelf())]));
    const open = this.button("chat-open-terminal", "Open terminal", "mods/workspace-chrome/terminal.svg", "primary", t, () => this.toTerminal());
    if (this.phase === "unsupported") return root.child(this.notice(t, "No chat for this agent",
      "Chat reads Claude Code's and Codex's own session logs. This agent works in its terminal only.", [open]));
    if (this.phase === "none") return root.child(this.notice(t, "Can't find this conversation",
      "Chat reads the agent's own session log, and Herdr can't tell which one this agent writes. Rather than show the wrong one, it shows none.", [open]));
    if (this.phase === "finding" || this.phase === "ended") return root.child(this.notice(t, this.swapping ? "Restarting the agent…" : "Opening the conversation…", null));

    this.sizeBox();
    const rows = this.rows();
    // A publish the registry doesn't list yet: read it again in a few seconds.
    if (rows.some((r) => r.kind === "artifact" && r.pending) || (this.conv?.items ?? []).some((x) => x.kind === "artifact") && !this.arts) {
      this.loadArts(cx);
      if (!this.artsTick) { this.artsTick = true; cx.timer.after(3500, (cx) => { this.artsTick = false; cx.notify(); }); }
    }
    // Find: the current match's row comes into view once per step.
    const found = this.finding ? this.findMatches(rows) : [];
    const current = found.length ? this.findRow(found) : null;
    if (this.findJump && current) { this.findJump = false; this.pinned = false; this.scroll.scroll_to_item(current.index, "center"); }
    const lit = new Set(found.map((m) => m.id));
    this.needViews([...this.files.filter((f) => f.image).map((f) => f.path), ...rows.flatMap((r) => (r.kind === "imgs" || r.kind === "gallery" ? r.paths : []))], cx);
    // What sits under the list (an ask card, the working line) changes its height: stay on the newest.
    const below = `${this.asks.length}|${(this.addr && openCard(this.addr)?.id) ?? ""}|${st}|${this.focused}|${this.queue.length}|${this.files.length}|${Boolean(this.quote)}|${this.notes.length}`;
    if (below !== this.below) { this.below = below; if (this.pinned) this.stick = true; }
    if (Math.abs(this.heightsFor - this.width) > 1) { this.heights.clear(); this.measuredAt.clear(); this.heightsFor = this.width; this.measureGen++; }
    const keys = rows.map((x) => this.key(x));
    // Every size a real number of pixels: one NaN, zero or runaway height leaves the list blank.
    const sizes = rows.map((x, i) => {
      const h = this.heights.get(keys[i]) ?? this.guess(x);
      return Number.isFinite(h) && h > 0 ? Math.min(h, 40000) : 60;
    });
    this.follow_bottom(rows);
    // Following the newest, the list sits at its end: the scroll position is exactly that.
    if (this.pinned && this.listH) this.scrollTop = Math.max(0, sizes.reduce((a, b) => a + b, 0) - (this.listH - 8));
    const body = rows.length === 0
      ? this.notice(t, "No messages", "Write to the agent below.")
      : v_flex().relative().flex_1().min_h(0).pt(8)
        .id("chat-body")
        .on_size_change((size, cx) => {
          const was = this.listH;
          this.listH = size.height;
          if (was && Math.abs(was - size.height) > 0.5 && this.pinned) { this.stick = true; cx.notify(); }
        })
        // How far down the list a press was, for the action bands (rows take no handlers).
        .on_mouse_down("left", (e) => { this.bodyPress = e.local_position?.y; })
        // Rows' hover styles show on a redraw: one per 6 px the pointer moves down or up.
        .on_mouse_move((e, cx) => {
          const b = Math.floor((e.local_position?.y ?? 0) / 6);
          if (b !== this.hoverBand) { this.hoverBand = b; cx.notify(); }
        })
        .on_hover((hovered, cx) => { if (!hovered) { this.hoverBand = null; cx.notify(); } })
        .on_scroll_wheel((e, cx) => {
          const y = e.delta?.y ?? 0;
          // Where the list is scrolled to, as near as known (the list doesn't say): wheel moves it.
          this.scrollTop = Math.max(0, (this.scrollTop ?? 0) - y);
          // Scrolling up to read stops following the newest; back at the bottom follows again.
          if (y > 0 && this.pinned) { this.pinned = false; cx.notify(); }
          if (y < 0 && !this.pinned && this.range && this.range.end >= rows.length) { this.pinned = true; cx.notify(); }
          if (y > 0 && (this.range?.start ?? 9) <= 1) this.loadEarlier(cx);
        })
        .child(v_virtual_list("chat-rows", rows.length, sizes, (i) => rows[i].id, (range) => {
          this.range = range;
          if (rows.length && !(range.end > range.start)) this.blank = true;
          // The first row on screen bounds the scroll position: keep the estimate inside it.
          const top = sizes.slice(0, range.start).reduce((a, b) => a + b, 0);
          if ((this.scrollTop ?? 0) < top || (this.scrollTop ?? 0) >= top + (sizes[range.start] ?? 0)) this.scrollTop = top;
          return rows.slice(range.start, range.end).map((x, j) => {
            const flash = this.flash && (x.id === this.flash.id || String(x.id).startsWith(`${this.flash.id}:`));
            return div().relative().w_full().h(sizes[range.start + j]).when(!x.bar || x.kind === "band", (el) => el.overflow_hidden())
              // Find: rows with matches tinted, the current one more.
              .when(lit.has(x.id), (el) => el.child(div().absolute().inset_0().rounded(10).bg(t.accent + (current?.id === x.id ? "38" : "14"))))
              // Ids carry the width's generation, as the measurer's do: a reply's words keep the
              // width they were first laid out at, so after a resize (a restart's first narrow
              // frames) they'd stay narrow and tall, spilling under the next row.
              .child(this.row(x, t, `v${this.measureGen}-`))
              .when(Boolean(flash), (el) => el.child(div().id(`flash-${x.id}`).absolute().inset_0().rounded(10).bg(t.accent + "26")
                .opacity(this.flash.on ? 1 : 0).transition("opacity", { duration: 1100, easing: "ease-out" })));
          });
        })
          .track_scroll(this.scroll).size_full()
          .on_item_click((key, cx) => this.clickRow(key, rows, cx, sizes)))
        .child(Scrollbar.vertical("chat-rows").absolute().inset_0())
        .child(this.measurer(rows, keys, t))
        // Cards' controls measured (strips.js hit()), and where question cards' keys come in.
        .child(strips.measure(t, rows.filter((r) => r.kind === "cardstrip").map((r) => r.s), this.cardW, (cx) => cx.notify()))
        .child(this.cards.sink("own"))
        .when(!this.pinned, (el) => {
          // Scrolled up: a card waiting below what's shown is pointed to; else the newest.
          const below = rows.map((r, i) => (r.kind === "cardstrip" && r.first && i >= (this.range?.end ?? rows.length) ? i : -1)).filter((i) => i >= 0);
          const label = below.length === 1 ? "1 question below" : below.length ? `${below.length} questions below` : "Latest";
          return el.child(h_flex().absolute().bottom(10).left(0).right(0).justify_center()
            .child(h_flex().id("chat-latest").h(26).px(10).gap(5).items_center().rounded(13).cursor_pointer()
              .bg(t.popover).border_1().border_color(t.border).shadow_md().text_size(12).text_color(t.muted)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => {
                if (below.length) this.scroll.scroll_to_item(below[0], "center");
                else { this.pinned = true; this.stick = true; }
                cx.notify();
              })
              .when(below.length > 0, (el) => el.child(div().size(6).flex_none().rounded(3).bg(red())))
              .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).flex_none()).child(label)));
        });
    return root
      .when(this.finding, (el) => el.child(this.findBar(t, rows)))
      .child(body)
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(18).py(4).text_size(12).text_color(t.blocked).truncate().child(this.error)))
      .child(this.statusLine(t, st) ?? div())
      .child(this.queued(t) ?? div())
      .child(this.background(t, st) ?? div())
      .child(this.composer(t, st))
      .child(div().flex_none().h(12));
  }

  // Rows not measured yet, drawn once out of sight at the list's width; their heights go to
  // the list, which then places every row exactly. Those near what is shown go first.
  measurer(rows, keys, t) {
    const near = this.anchor && Date.now() < this.anchor.until
      ? Math.max(0, rows.findIndex((r) => r.id === this.anchor.id))
      : this.range ? this.range.start : rows.length - 1;
    // Rows never measured, nearest first; and, measured again, the rows on screen and those
    // measured in the last few seconds: markdown can lay out a moment after its first frame (a
    // long message first measures as one line), so a height is never taken once and kept.
    const now = Date.now();
    const lo = Math.max(0, (this.range?.start ?? rows.length) - 2), hi = Math.min(rows.length, (this.range?.end ?? 0) + 2);
    const fresh = rows.map((_, i) => i).filter((i) => !this.heights.has(keys[i]))
      .sort((a, b) => Math.abs(a - near) - Math.abs(b - near)).slice(0, 30);
    const again = rows.map((_, i) => i).filter((i) => this.heights.has(keys[i]) && ((i >= lo && i < hi) || now - (this.measuredAt.get(keys[i]) ?? 0) < 4000));
    const order = [...new Set([...fresh, ...again])].slice(0, 60);
    return div().absolute().top(0).left(0).w(this.width).h(0).overflow_hidden().opacity(0)
      .child(v_flex().w_full().children(order.map((i) => div().id(`m${this.measureGen}-${keys[i]}`).flex_none().w_full()
        .on_size_change((size, cx) => {
          if (!this.measuredAt.has(keys[i])) this.measuredAt.set(keys[i], Date.now());
          if (this.heights.get(keys[i]) === size.height) return;
          this.heights.set(keys[i], size.height);
          if (this.pinned) this.stick = true;
          if (this.anchor && Date.now() < this.anchor.until) this.reanchor = true;
          cx.notify();
        })
        .child(this.row(rows[i], t, "m-")))));
  }
}
