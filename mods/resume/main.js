// Resume a session, from the + menu: the space's agents that cmd-w parked (still running:
// Open gives one a tab again, mods/tabs-sandbox) and the Claude Code and Codex sessions
// that ran in its folders and ended (agent/sessions): Resume starts one again in a new
// tab, in the sandbox or not. Props: { space }.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { spaces, panes, terminals, run, hc, theme, props, closeOverlay, knownAgents, appHome, readTextFile, exec as execFile } from "herdr";

const PARKED = "parked.space";

function ago(at) {
  const s = Math.max(0, Date.now() / 1000 - at);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default class Resume extends View {
  init(_props, cx) {
    this.sessions = null;
    this.agents = [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      const s = this.space(), tabs = new Set((s?.tabs ?? []).map((c) => c.id));
      const folders = [...new Set([s?.folder, ...panes().filter((p) => tabs.has(p.tab)).map((p) => p.cwd), ...this.parked().map((x) => x.cwd)])].filter(Boolean);
      // Claude Code sessions open in a terminal now: the status line feed names each one's.
      const live = new Set();
      for (const x of terminals()) {
        if (x.state !== "live") continue;
        const feed = await readTextFile(`${appHome()}/usage/claude/${x.address}.json`).catch(() => null);
        try { const id = JSON.parse(feed ?? "null")?.session; if (id) live.add(id); } catch {}
      }
      const r = s?.machine ? null : await execFile(`${appHome()}/agent/sessions`, folders).catch(() => null);
      try { this.sessions = JSON.parse(r?.stdout || "[]").filter((x) => !live.has(x.id)); } catch { this.sessions = []; }
      this.agents = await knownAgents().catch(() => []);
      cx.notify();
    });
  }

  space() {
    return spaces().find((s) => s.id === props()?.space) ?? spaces().find((s) => s.active);
  }

  // Parked here and not given a pane again since (that labels it with a space once more).
  parked() {
    const id = this.space()?.id;
    return terminals().filter((x) => x.state === "live" && x.labels?.[PARKED] === id && !x.labels?.["herdr.space"]);
  }

  close() { closeOverlay(props().overlay); }

  open(x) {
    hc(["label", x.address, `${PARKED}=`]);
    run("terminal.keep", { terminal: x.address });
    this.close();
  }

  // The + menu's own entries (programs.json), with the session to resume added.
  resume(s, sandboxed) {
    const key = s.app === "claude" ? "claude" : "codex";
    const a = this.agents.find((a) => a.key === (sandboxed ? key : `${key}-unsandboxed`)) ?? this.agents.find((a) => a.key === key);
    const argv = [...(a?.run ?? [key]), ...(s.app === "claude" ? ["--resume", s.id] : ["resume", s.id])];
    run("tab.new", { space: this.space()?.id, name: s.title, folder: s.folder, argv });
    this.close();
  }

  button(id, label, primary, action) {
    const t = theme();
    return h_flex().id(id).h(24).px(9).flex_none().items_center().rounded(6).text_size(12).font_medium().cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88))
      .on_click(() => action()).child(label);
  }

  row(id, pic, title, sub, buttons) {
    const t = theme();
    return h_flex().id(id).min_h(44).px(10).py(6).gap(10).items_center().rounded(8).hover((s) => s.bg(t.hover))
      .child(pic)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_color(t.foreground).child(title))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(sub)))
      .children(buttons);
  }

  icon(app) {
    return image(app === "codex" ? "icons/codex.svg" : "icons/claude.svg").size(16).flex_none();
  }

  render() {
    const t = theme();
    const parked = this.parked();
    const head = (label) => div().px(10).pt(10).pb(4).text_size(11).font_medium().text_color(t.dim).child(label);
    const empty = this.sessions !== null && !parked.length && !this.sessions.length;
    return v_flex().id("resume").track_focus(this.handle).size_full().bg(t.popover).text_size(13)
      .on_key_down((e) => { if (e.key === "escape") this.close(); })
      .child(h_flex().h(44).flex_none().px(16).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_color(t.foreground).child(`Resume a session${this.space() ? ` in ${this.space().name}` : ""}`)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .when(parked.length > 0, (el) => el.child(head("Still running"))
          .children(parked.map((x) => this.row(`parked-${x.address}`, x.program?.icon ? image(x.program.icon).size(16).flex_none() : this.icon("claude"),
            x.title || x.name || x.program?.name || x.address, `${x.program?.name ?? "Agent"} · parked by cmd-w`,
            [this.button(`open-${x.address}`, "Open", true, () => this.open(x))]))))
        .when(Boolean(this.sessions?.length), (el) => el.child(head("Ended"))
          .children(this.sessions.map((s) => this.row(`s-${s.id}`, this.icon(s.app), s.title,
            `${s.app === "codex" ? "Codex" : "Claude Code"} · ${ago(s.at)}`,
            [this.button(`sb-${s.id}`, "Resume", true, () => this.resume(s, true)),
             this.button(`nsb-${s.id}`, "No sandbox", false, () => this.resume(s, false))]))))
        .when(this.sessions === null, (el) => el.child(div().p(10).text_color(t.dim).child("Looking for sessions…")))
        .when(empty, (el) => el.child(div().p(10).text_color(t.dim).child("No parked agents or past sessions in this space's folders."))));
  }
}
