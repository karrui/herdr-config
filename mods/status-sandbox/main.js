import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, focused, exec, theme } from "herdr";
import { chatAgents } from "./parked.js";

// Herdr's status bar (workspace-status), without its command palette hint.
export default class WorkspaceStatus extends View {
  // With a chat focused, Herdr reports no branch (its pane isn't a terminal): the branch of the
  // chat agent's folder instead, read again every few seconds.
  init(_props, cx) {
    this.chatBranch = null;
    cx.timer.every(3000, (cx) => cx.spawn(async (cx) => {
      const f = focused();
      const k = f?.pane && !f.terminal && terminals().find((x) => x.labels?.["herdr.chat"] === f.pane && x.state === "live");
      const cwd = k && (k.foreground?.cwd ?? k.cwd);
      const r = cwd ? await exec("git", ["branch", "--show-current"], { cwd }).catch(() => null) : null;
      const b = r?.code === 0 ? r.stdout.trim() || null : null;
      if (b !== this.chatBranch) { this.chatBranch = b; cx.notify(); }
    }));
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const branch = space?.branch ?? this.chatBranch;
    const list = [...agents(), ...chatAgents()];
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(branch), el => el.child(label("branch", branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agent${list.length === 1 ? "" : "s"}`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))));
  }
}
