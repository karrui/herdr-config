// The Usage popup (the sidebar footer's Usage): Claude's and Codex's plan limits, account-wide, from whichever of
// their sessions reported last. Claude's status line saves them each turn
// (usage/claude-statusline, into usage/claude/<terminal>.json); Codex's are in its
// newest session file (usage/codex-usage, given no terminal).
// herdr's exec takes an argv list and never goes through a shell.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec as execFile, theme, appHome, readTextFile, watchFolder, window, props, closeOverlay } from "herdr";
import * as fs from "fs/promises";

const DIR = `${appHome()}/usage`;
const CLAUDE = `${DIR}/claude`;
// Codex has no feed to watch: read again this often while the window is in front.
const EVERY = 30000;

// resetAt and level are copies of mods/agent-bar/usage.js's: mods can't import each other.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function resetAt(sec) {
  const d = new Date(sec * 1000), h = d.getHours();
  const time = `${String(h % 12 || 12).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return d.toDateString() === new Date().toDateString() ? time : `${DAYS[d.getDay()]} ${time}`;
}
const level = (t, pct) => pct >= 90 ? t.blocked : pct >= 75 ? t.ansi3 : t.foreground;

function ago(sec) {
  const m = Math.floor((Date.now() / 1000 - sec) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}

// "seven_day_opus" -> "Weekly, Opus": the name Claude Code gives a window, for its row.
function windowName(key) {
  const [, span, model] = key.match(/^(five_hour|seven_day)_?(.*)$/) ?? [];
  const name = { five_hour: "5-hour", seven_day: "Weekly" }[span] ?? key.replace(/_/g, " ");
  return model ? `${name}, ${model[0].toUpperCase()}${model.slice(1).replace(/_/g, " ")}` : name;
}

// The newest reading with limits any Claude session saved, or null: every window its
// status line reports (a model's own weekly limit too, once Claude Code sends one).
async function claude() {
  const files = (await fs.readdir(CLAUDE).catch(() => [])).filter((f) => f.endsWith(".json"));
  const all = await Promise.all(files.map(async (f) => { try { return JSON.parse(await readTextFile(`${CLAUDE}/${f}`)); } catch { return null; } }));
  const u = all.filter((u) => u?.five != null || u?.week != null).reduce((a, b) => (!a || (b.at ?? 0) > (a.at ?? 0) ? b : a), null);
  if (!u) return null;
  const windows = u.limits ? Object.entries(u.limits).filter(([, w]) => w?.used_percentage != null)
    .map(([key, w]) => ({ key, name: windowName(key), pct: w.used_percentage, reset: w.resets_at }))
    : [["five_hour", u.five, u.five_reset], ["seven_day", u.week, u.week_reset]].filter(([, pct]) => pct != null)
      .map(([key, pct, reset]) => ({ key, name: windowName(key), pct, reset }));
  return { at: u.at, windows };
}

async function codex() {
  const r = await execFile(`${DIR}/codex-usage`, []).catch(() => null);
  let u = null;
  try { u = JSON.parse(r?.stdout.trim() || "null"); } catch {}
  return u && { at: u.at, windows: [["five_hour", u.five, u.five_reset], ["seven_day", u.week, u.week_reset]].filter(([, pct]) => pct != null)
    .map(([key, pct, reset]) => ({ key, name: windowName(key), pct, reset })) };
}

export default class Usage extends View {
  init(_props, cx) {
    this.claude = undefined; // undefined: reading, null: no reading
    this.codex = undefined;
    this.load(cx);
    cx.timer.every(EVERY, (cx) => { if (window()?.active) this.load(cx); });
    // "3m ago" and resets that have passed move with the clock.
    cx.timer.every(60000, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(CLAUDE); } catch { return; }
        this.load(cx);
      }
    });
  }

  load(cx) {
    cx.spawn(async (cx) => {
      [this.claude, this.codex] = await Promise.all([claude(), codex()]);
      cx.notify();
    });
  }

  // A window's share used, and when it resets. Past its reset, the reading is old news: 0%.
  meter(id, w, t) {
    const passed = Boolean(w.reset) && w.reset * 1000 <= Date.now(), p = passed ? 0 : w.pct;
    return v_flex().id(id).gap(5)
      .child(h_flex().gap(6).items_baseline()
        .child(div().text_color(t.foreground).child(w.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(passed ? "reset since" : w.reset ? `resets ${resetAt(w.reset)}` : ""))
        .child(div().text_color(level(t, p)).child(`${Math.round(p)}%`)))
      .child(div().h(5).w_full().rounded(3).bg(t.raised)
        .child(div().h(5).w(`${Math.max(2, Math.min(100, p))}%`).rounded(3).bg(p >= 75 ? level(t, p) : t.muted)));
  }

  section(id, name, icon, u, missing, t) {
    const note = (text) => div().text_size(11.5).text_color(t.dim).child(text);
    return v_flex().id(id).px(14).py(10).gap(9)
      .child(h_flex().gap(7).items_center().child(image(icon).size(14)).child(div().flex_1().font_semibold().child(name))
        .when(Boolean(u?.at), (el) => el.child(note(ago(u.at)))))
      .when(u === undefined, (el) => el.child(note("Reading…")))
      .when(u === null, (el) => el.child(note(missing)))
      .children((u?.windows ?? []).map((w) => this.meter(`${id}-${w.key}`, w, t)));
  }

  render(cx) {
    const t = theme();
    return v_flex().id("usage").size_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); } })
      .child(h_flex().h(36).flex_none().pl(14).pr(6).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().child("Usage limits"))
        .child(div().id("usage-refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Read again (account-wide, as the agents last reported)")
          .on_click((_e, cx) => this.load(cx)).child(svg("mods/menu-hooks/rotate-ccw.svg").size(13))))
      .child(this.section("claude", "Claude Code", "icons/claude.svg", this.claude,
        "No reading yet. Claude Code reports its limits after a turn, once its status line is set up (see the README).", t))
      .child(div().h(1).mx(14).bg(t.border))
      .child(this.section("codex", "Codex", "icons/codex.svg", this.codex, "No reading yet. Codex reports its limits after a turn.", t));
  }
}
