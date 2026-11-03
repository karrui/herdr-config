import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { exec as execFile, theme, focused, window, watchFolder, openOverlay, closeOverlay, props, settings } from "herdr";
import * as fs from "fs/promises";
import { DIR as SANDBOX_DIR, BLOCKED, runOf, loadBlocked, loadRules, allowed, needsWrite, splitPath, allowUpTo, openSandboxLists } from "./sandbox.js";
import { CLAUDE, agentAt, loadUsage, usageKey, tokens, resetAt, level } from "./usage.js";

const ICON = "mods/agent-bar/shield.svg";
const POPOVER_WIDTH = 300;

function ago(time) {
  const s = Math.max(0, Date.now() / 1000 - time);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// The focused agent's usage and sandbox in the status bar. Opened again as an overlay,
// it is the usage popover ({view: "usage", address}) or the blocked list ({view: "blocked", run}).
export default class AgentBar extends View {
  init(_props, cx) {
    this.view = props()?.view ?? "footer";
    this.usage = null;
    this.entries = [];
    this.rules = [];
    this.hover = null;
    cx.spawn(async cx => {
      await fs.mkdir(BLOCKED, { recursive: true });
      await fs.mkdir(CLAUDE, { recursive: true });
      this.refresh(cx);
      for (;;) {
        // ponytail: one watch on the app folder covers both feeds; a reload costs one awk or file read.
        try { await Promise.race([watchFolder(BLOCKED), watchFolder(CLAUDE)]); } catch { return; }
        this.refresh(cx);
      }
    });
  }

  address() { return this.view === "footer" ? focused()?.terminal ?? null : props().address; }
  run() { return this.view === "blocked" ? props().run : runOf(this.address()); }
  // Changes when you switch tabs or come back to the window, which reloads the numbers.
  key() { return `${usageKey(agentAt(this.address()))}|${this.run()}|${window()?.active}`; }

  refresh(cx) {
    const key = this.key(), agent = agentAt(this.address()), run = this.run();
    this.loaded = key;
    cx.spawn(async cx => {
      const [usage, entries, rules] = await Promise.all([
        this.view === "blocked" ? null : loadUsage(agent),
        this.view === "usage" || !run ? [] : loadBlocked(run),
        this.view === "blocked" ? loadRules() : [],
      ]);
      if (key !== this.loaded) return;
      Object.assign(this, { usage, entries, rules });
      cx.notify();
    });
  }

  render(cx) {
    if (this.key() !== this.loaded) this.refresh(cx);
    if (this.view === "usage") return this.popover();
    if (this.view === "blocked") return this.list();
    if (this.view === "confirm") return this.confirm();
    return this.footer();
  }

  // Footer

  chip(id, pct, label, width) {
    const t = theme();
    return div().id(id).relative().h(20).w(width).flex_none().rounded(5).bg(t.raised).overflow_hidden()
      .child(div().absolute().left(0).top(0).h_full().w(Math.round(width * Math.min(100, pct) / 100)).bg(t.selected))
      .child(h_flex().relative().size_full().gap(4).items_center().justify_center()
        .child(div().text_color(level(t, pct)).child(`${Math.round(pct)}%`))
        .child(div().text_color(t.muted).child(label)));
  }

  footer() {
    const t = theme();
    const agent = agentAt(this.address());
    const u = agent ? this.usage : null;
    const run = this.run();
    const total = this.entries.reduce((n, e) => n + e.count, 0);
    const chips = [
      u?.ctx != null && this.chip("ctx", u.ctx, "ctx", 72),
      u?.five != null && this.chip("five", u.five, "5h", 64),
      u?.week != null && this.chip("week", u.week, "wk", 64),
    ].filter(Boolean);
    return h_flex().size_full().px(14).gap(14).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .when(chips.length > 0, el => el.child(h_flex().id("usage").gap(5).items_center().cursor_pointer()
        .on_click(() => openOverlay({ mod: "agent-bar", kind: "popup", width: POPOVER_WIDTH, height: this.popoverHeight(u), props: { view: "usage", address: agent.address } }))
        .children(chips)))
      .when(Boolean(run), el => el.child(div().id("blocked").cursor_pointer().text_color(total ? t.ansi3 : t.dim).hover(s => s.text_color(t.foreground))
        .on_click(() => openOverlay({ mod: "agent-bar", kind: "dialog", width: 900, height: 560, props: { view: "blocked", run } }))
        .child(`${total} blocked`)))
      .child(h_flex().id("sandbox").gap(6).items_center().text_color(run ? t.ansi2 : t.dim)
        .child(svg(ICON).size(13)).child(run ? "Sandbox: enforcing (fs)" : "Sandbox: off")
        .when(Boolean(agent), el => el.cursor_pointer().hover(s => s.text_color(t.foreground))
          .tooltip(run ? "Restart this agent without the sandbox" : "Restart this agent in the sandbox")
          .on_click(() => openOverlay({ mod: "agent-bar", kind: "dialog", width: 440, height: 196, props: { view: "confirm", address: agent.address, on: !run } }))))
      .child(div().id("sandbox-lists").flex_none().cursor_pointer().text_color(t.dim).hover(s => s.text_color(t.foreground))
        .tooltip("Sandbox allow and deny lists").on_click(() => openSandboxLists())
        .child(svg("mods/workspace-chrome/settings.svg").size(13)));
  }

  // Sandbox toggle confirmation

  confirm() {
    const t = theme();
    const { address, on, overlay } = props();
    const name = agentAt(address)?.program?.name ?? "the agent";
    const go = cx => {
      if (this.busy) return;
      this.busy = true;
      this.error = null;
      cx.notify();
      cx.spawn(async cx => {
        const r = await execFile(`${SANDBOX_DIR}/agent-restart`, [address, on ? "on" : "off"]).catch(e => ({ code: 1, stderr: String(e) }));
        this.busy = false;
        if (r.code === 0) return closeOverlay(overlay);
        this.error = r.stderr.trim() || "Restarting failed.";
        cx.notify();
      });
    };
    const button = (id, label, bg, fg, action) => div().id(id).px(14).py(6).rounded(6).cursor_pointer().bg(bg).text_color(fg)
      .hover(s => s.opacity(0.85)).on_click((_e, cx) => action(cx)).child(label);
    return v_flex().size_full().bg(t.popover).p(20).gap(10).text_size(13)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(on ? "Turn the sandbox on?" : "Turn the sandbox off?"))
      .child(div().text_color(t.muted).child(on
        ? `Restarts ${name} in this tab inside the sandbox and resumes the same conversation. Anything it's doing now stops.`
        : `Restarts ${name} in this tab without the sandbox and resumes the same conversation. It will be able to read and write anywhere you can. Anything it's doing now stops.`))
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(button("cancel", "Cancel", t.raised, t.foreground, () => closeOverlay(overlay)))
        .child(button("restart", this.busy ? "Restarting…" : on ? "Restart sandboxed" : "Restart unsandboxed", t.solid, t.solid_foreground,
          go)));
  }

  // Usage popover

  popoverHeight(u) {
    return 58 + (u?.ctx != null ? 84 : 0) + (u?.five != null ? 72 : 0) + (u?.week != null ? 72 : 0) + (u?.cost != null ? 82 : 0) + 44;
  }

  meter(id, title, pct, left, right) {
    const t = theme();
    const width = POPOVER_WIDTH - 36;
    return v_flex().id(id).px(18).py(10).gap(7)
      .child(h_flex().justify_between().child(div().text_color(t.foreground).child(title)).child(div().text_color(level(t, pct)).child(`${Math.round(pct)}%`)))
      .child(div().h(6).w(width).rounded(3).bg(t.raised)
        .child(div().h(6).w(Math.max(6, Math.round(width * Math.min(100, pct) / 100))).rounded(3).bg(pct >= 75 ? level(t, pct) : t.muted)))
      .child(h_flex().justify_between().text_size(12).text_color(t.dim).child(left).child(right));
  }

  popover() {
    const t = theme();
    const agent = agentAt(this.address());
    const u = this.usage;
    const p = agent?.program;
    const rule = () => div().h(1).mx(18).bg(t.border);
    return v_flex().size_full().bg(t.popover).text_size(13)
      .child(h_flex().h(46).px(18).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(p?.icon), el => el.child(p.tint ? svg(p.icon).size(15).text_color(t.foreground) : image(p.icon).size(15)))
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(p?.name ?? agent?.app ?? "Agent"))
        .when(Boolean(u?.model), el => el.child(div().text_size(12).text_color(t.dim).child(u.model))))
      .when(!u, el => el.child(div().px(18).py(14).text_color(t.dim).child("No reading yet. It arrives after the agent's next turn.")))
      .when(u?.ctx != null, el => el.child(this.meter("m-ctx", "Context", u.ctx, "this conversation",
        u.ctx_tokens != null && u.ctx_size ? `${tokens(u.ctx_tokens)} / ${tokens(u.ctx_size)} tokens` : "")).child(rule()))
      .when(u?.five != null, el => el.child(this.meter("m-five", "Session", u.five, "rolling 5 hours", u.five_reset ? `resets ${resetAt(u.five_reset)}` : "")))
      .when(u?.week != null, el => el.child(this.meter("m-week", "Weekly", u.week, "rolling 7 days", u.week_reset ? `resets ${resetAt(u.week_reset)}` : "")))
      .when(u?.cost != null, el => el.child(rule()).child(v_flex().px(18).py(12).gap(4)
        .child(h_flex().justify_between().child(div().text_color(t.foreground).child("Would have cost"))
          .child(div().font_semibold().text_color(t.foreground).child(`$${u.cost.toFixed(2)}`)))
        .child(div().text_size(12).text_color(t.dim).child("at API rates this session. Your plan covers it."))))
      .child(rule())
      .child(div().px(18).py(12).text_size(12).text_color(t.dim).child("Reported by the agent as it works."));
  }

  // Blocked list

  segments(entry, row) {
    const t = theme();
    const { root, parts } = splitPath(entry.path);
    const done = allowed(this.rules, entry);
    const hovered = this.hover?.row === row ? this.hover.upto : -1;
    const sep = () => div().px(5).text_color(t.dim).child("/");
    return h_flex().min_w(0).flex_1().items_center().overflow_hidden()
      .child(div().flex_none().text_color(t.dim).child(root))
      .children(parts.flatMap((part, i) => [sep(),
        div().id(`seg-${row}-${i}`).flex_none()
          .text_color(done ? t.dim : hovered < 0 ? t.foreground : i <= hovered ? t.ansi2 : t.dim)
          .when(!done, el => el.cursor_pointer()
            .on_hover((on, cx) => {
              if (on) this.hover = { row, upto: i };
              else if (this.hover?.row === row && this.hover.upto === i) this.hover = null;
              cx.notify();
            })
            .on_click((_e, cx) => cx.spawn(async cx => {
              await allowUpTo(entry, i);
              this.rules = await loadRules();
              cx.notify();
            })))
          .child(part)]));
  }

  list() {
    const t = theme();
    const rows = this.entries.slice(0, 400);
    const button = (id, label, action) => div().id(id).px(8).py(3).rounded(5).cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover)).on_click(action).child(label);
    return v_flex().size_full().bg(t.popover).p(14).gap(10).text_size(12.5)
      .child(h_flex().items_center().gap(10)
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("BLOCKED FILESYSTEM PATHS"))
        .child(div().text_color(t.dim).child(String(this.entries.length)))
        .child(button("edit-lists", "Edit allow and deny lists", () => openSandboxLists()))
        .child(button("close", "Close", () => closeOverlay(props().overlay))))
      .child(div().text_color(t.dim).child("Click a path segment to allow it for every sandboxed agent: green = will be allowed, dimmed = trimmed off. Allowed paths apply the next time the agent starts."))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().font_family(settings().font_family ?? "JetBrains Mono")
        .when(rows.length === 0, el => el.child(div().py(8).text_color(t.dim).child("Nothing blocked yet.")))
        .children(rows.map((e, row) => {
          const ok = allowed(this.rules, e);
          return h_flex().id(`row-${row}`).h(28).px(8).gap(14).rounded(5).items_center().flex_none().hover(s => s.bg(t.hover))
            .child(this.segments(e, row))
            .child(div().flex_none().text_color(ok ? t.ansi2 : t.dim).child(ok ? "allowed · restart agent" : needsWrite(e.op) ? "write" : "read"))
            .child(div().flex_none().text_color(t.muted).child(e.proc))
            .child(div().flex_none().w(110).text_color(t.dim).child(`${e.count}× · ${ago(e.time)}`));
        })));
  }
}
