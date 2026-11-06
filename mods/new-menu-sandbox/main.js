import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { theme, spaces, panes, terminals, focused, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, setShared, exec as execFile, notify, appHome } from "herdr";
import { remoteRun } from "./launch.js";

// Claude Code and Codex start as a chat: their tab's pane header (pane-sandbox) swaps the new
// terminal for the chat once it shows, from this label. Terminal there shows the CLI again.
// The terminal labels itself before the agent starts: the menu closes as it starts one, and a
// label set here once tab.new answered was dropped with it.
function start(a, space, folder) {
  const chat = /^(claude|codex)(-|$)/.test(a.key ?? "");
  const argv = chat ? ["sh", "-c", 'hc label "$HC_TERMINAL_ID" chat.start=1 >/dev/null 2>&1; exec "$@"', "sh", ...a.run] : a.run;
  run("tab.new", { name: a.name, space: space?.id, folder, argv });
}

// The last agents each machine reported, shown at once while knownAgents() checks again.
const KNOWN = "new-menu.agents";
// Sizes: a row, the "Start an agent" heading, a separator, the menu's padding.
const ROW = 31, HEAD = 26, SEP = 9, PAD = 5;

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(_props, cx) {
    const machine = spaces().find(s => s.active)?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async cx => {
      try {
        this.agents = await knownAgents({ on: machine });
        if (machine) {
          const result = await execFile("sh", ["-c", 'app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"; printf "%s\\n" "$app"; uname -s; for c in claude codex; do command -v "$c" >/dev/null 2>&1 && printf "%s\\n" "$c"; done; [ -x "$app/agent/launch" ] && echo runtime; true'], { on: machine });
          if (result.code !== 0) throw new Error(result.stderr);
          const [app, platform, ...installed] = result.stdout.trim().split("\n");
          this.agents = this.agents.map(a => /^(claude|codex)(-|$)/.test(a.key ?? "") && a.run.some(x => /\/agent\/launch$/.test(x))
            ? { ...a, run: remoteRun(a.run, app, platform), installed: installed.includes(a.key.startsWith("claude") ? "claude" : "codex") && installed.includes("runtime") } : a);
        }
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }
  // Herdr's menu metrics (its right-click menu): 31 rows, 8 in, 9 between icon and name.
  row(id, icon, name, action, hint = "", enabled = true) {
    const t = theme();
    return h_flex().id(id).h(ROW).px(8).gap(9).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(div().flex_none().text_color(enabled ? t.muted : t.dim).child(icon)).child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
  }
  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
    // Chat panes park their terminal; use its live folder before closing the popup.
    const terminal = pane?.mod === "chat" ? terminals().find(t => t.state === "live" && t.labels?.["herdr.chat"] === pane.pane) : null;
    const folder = terminal?.foreground?.cwd || terminal?.cwd || pane?.cwd || f?.cwd || space?.folder;
    const installed = this.agents.filter(a => a.installed);
    const choices = [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)];
    // Its height is what its parts add up to (the agents list scrolls past 9), so none is squeezed.
    const height = PAD * 2 + ROW * 2 + HEAD + ROW * Math.min(9, Math.max(1, choices.length)) + ROW + SEP + ROW * 3;
    return v_flex().min_h(0).w_full().h(height).bg(t.popover).p(PAD).text_size(12.8)
      .id("new-menu").track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        closeOverlay(props().overlay);
        start(agent, space, folder);
      })
      .child(this.row("terminal", svg("icons/shell.svg").size(14), "Terminal", () => run("tab.new", { space: space?.id, folder }), shortcut("tab.new")))
      // The shared Chrome agents drive over CDP (browser/open starts it or brings it forward).
      .child(this.row("browser", svg("mods/new-menu-sandbox/browser.svg").size(14), "Browser", () => execFile(`${appHome()}/browser/open`, [])
        .then(r => r, e => ({ code: 1, stderr: String(e) }))
        .then(r => r.code && notify({ title: "Couldn't open the browser", body: r.stderr.trim(), level: "error" }))))
      .child(div().h(HEAD).flex_none().px(8).pt(9).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(v_flex().id("agents").flex_1().min_h(0).overflow_y_scrollbar()
        .children(choices.map((a, i) => this.row(a.key, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
          () => start(a, space, folder), a.installed ? (i < 9 ? String(i + 1) : "") : "not installed", a.installed)))
        .when(this.agents.length === 0, el => el.child(div().h(ROW).flex_none().flex().items_center().px(8).text_color(t.dim).child(this.failed ? "Could not load agents" : "Checking installed agents…"))))
      // Agents cmd-w parked here, and sessions that ran in this space's folders (mods/resume).
      .child(this.row("resume", svg("mods/workspace-chrome/clock.svg").size(14), "Resume a session\u2026", () => openOverlay({ mod: "resume", kind: "dialog", width: 520, height: 480, props: { space: space?.id } }), "", Boolean(space)))
      .child(div().h(SEP).flex_none().px(7).py(4).child(div().h(1).w_full().bg(t.border)))
      .child(this.row("space", svg("mods/workspace-chrome/plus.svg").size(14), "New space", () => run("space.new"), shortcut("space.new")))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree…", () => openOverlay({ mod: "worktree-hooks", kind: "dialog", width: 460, height: 320, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree\u2026", () => openOverlay({ mod: "worktree-hooks", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "open" } }), "", Boolean(space)));
  }
}
