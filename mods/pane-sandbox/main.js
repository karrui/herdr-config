// A pane's header (Herdr's `pane` mod, cloned), plus Run: the commands Claude Code's
// latest reply asks you to run with `!` (`! gh auth login`, inline or in a code block).
// Run types `! <command>` into the agent, so it runs in its session and its output
// lands in the conversation; several are listed on hover. Props from the app:
// { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { panes, props, run, theme, home, hc, appHome, readTextFile, settings, watchFolder, exec as execFile } from "herdr";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// The `! command`s in a reply: `! cmd` in backticks, and lines starting "! " in code
// blocks. Ones with a placeholder to fill in (`--input <that path>`) are left out.
export function bangs(text) {
  const found = [...text.matchAll(/`!\s*([^`\n]+)`/g)].map((m) => m[1]);
  for (const [, block] of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const [, cmd] of block.matchAll(/^\s*!\s*(\S.*)$/gm)) found.push(cmd);
  }
  return [...new Set(found.map((c) => c.trim()))].filter((c) => c && !/<[a-z][^>]*>/i.test(c));
}

// The agent's transcript, as the status line feed names it.
async function transcript(terminal) {
  const feed = await readTextFile(`${appHome()}/usage/claude/${terminal}.json`).catch(() => null);
  try { return JSON.parse(feed ?? "null")?.transcript ?? null; } catch { return null; }
}

// What Claude Code said since you last wrote to it: its transcript's assistant text after
// the last prompt (a tool's result is not one).
async function suggestions(file) {
  // ponytail: the last 300 entries; a reply longer than that loses its start.
  const r = await execFile("/usr/bin/tail", ["-n", "300", file]).catch(() => null);
  const texts = [];
  for (const line of (r?.stdout ?? "").split("\n").reverse()) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e.message?.content;
    if (e.type === "user" && !e.isMeta && (typeof content === "string" || content?.some?.((c) => c.type === "text"))) break;
    if (e.type === "assistant" && Array.isArray(content)) for (const c of content) if (c.type === "text") texts.unshift(c.text);
  }
  return bangs(texts.join("\n"));
}

export default class Pane extends View {
  init() { this.hovered = false; this.cmds = []; this.seen = null; this.watched = null; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // Looked at again when the agent's status changes: a reply ends, or you write.
  look(p, cx) {
    const key = `${p.terminal}|${p.app}|${p.status}`;
    if (key === this.seen) return;
    this.seen = key;
    if (p.app !== "claude-code" || !p.terminal) { this.cmds = []; return; }
    cx.spawn(async (cx) => {
      const file = await transcript(p.terminal);
      const cmds = file ? await suggestions(file) : [];
      if (this.seen !== key) return;
      this.cmds = cmds;
      if (file) this.watch(file, cx);
      cx.notify();
    });
  }

  // The status can turn before Claude Code has written the reply out, so its transcript
  // is read again whenever it changes while the agent isn't working.
  watch(file, cx) {
    if (this.watched === file) return;
    this.watched = file;
    const dir = file.slice(0, file.lastIndexOf("/")), name = file.slice(dir.length + 1);
    cx.spawn(async (cx) => {
      while (this.watched === file) {
        const changed = await watchFolder(dir).catch(() => null);
        if (!changed) return;
        if (this.watched === file && changed.some((f) => f.endsWith(name)) && this.me()?.status !== "working") { this.seen = null; cx.notify(); }
      }
    });
  }

  runCmd(p, cmd) {
    this.cmds = this.cmds.filter((c) => c !== cmd);
    hc(["send", p.terminal, `! ${cmd}`]);
  }

  runChip(t, p) {
    const mono = settings().font_family ?? "JetBrains Mono";
    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const chip = h_flex().id(`ph-run-${p.pane}`).h(20).px(7).gap(5).flex_none().max_w(280).items_center().rounded(5)
      .bg(t.accent + "1f").text_color(t.accent).text_size(11.5).cursor_pointer().hover((s) => s.bg(t.accent + "33"))
      .child(svg("mods/pane-sandbox/play.svg").size(10).flex_none());
    if (this.cmds.length === 1) {
      const [cmd] = this.cmds;
      return stop(chip).tooltip(`Run in Claude Code: ! ${cmd}`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.runCmd(p, cmd); cx.notify(); })
        .child(div().min_w(0).truncate().font_family(mono).child(cmd));
    }
    const item = (cmd, i) => stop(h_flex().id(`ph-run-${p.pane}-${i}`).h(26).px(8).gap(7).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.runCmd(p, cmd); cx.notify(); })
      .child(svg("mods/pane-sandbox/play.svg").size(10).flex_none().text_color(t.accent))
      .child(div().min_w(0).truncate().font_family(mono).text_color(t.foreground).child(cmd)));
    return HoverCard.new(`ph-runs-${p.pane}`).open_delay(150).anchor("top_right")
      .trigger(stop(chip).child(`Run (${this.cmds.length})`))
      .content(v_flex().w(380).p(4).gap(1).rounded(10).bg(t.popover).border(1).border_color(t.border).text_size(12)
        .child(div().px(8).pt(4).pb(2).text_size(11).text_color(t.dim).child("Claude Code asks you to run"))
        .children(this.cmds.map(item)));
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    this.look(p, cx);
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(this.cmds.length > 0 && st !== "working", (el) => el.child(this.runChip(t, p)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
