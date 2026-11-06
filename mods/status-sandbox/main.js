import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { spaces, agents, terminals, focused, exec, theme, window, notify } from "herdr";
import { chatAgents } from "./parked.js";
import { scanApps, openApp, appURLs } from "./apps.js";

// Herdr's status bar (workspace-status), without its command palette hint.
export default class WorkspaceStatus extends View {
  // With a chat focused, Herdr reports no branch (its pane isn't a terminal): the branch of the
  // chat agent's folder instead, read again every few seconds.
  init(_props, cx) {
    this.apps = [];
    this.chatBranch = null;
    cx.timer.every(5000, cx => { if (window()?.active) this.refreshApps(cx); });
    cx.timer.every(3000, (cx) => cx.spawn(async (cx) => {
      const f = focused();
      const k = f?.pane && !f.terminal && terminals().find((x) => x.labels?.["herdr.chat"] === f.pane && x.state === "live");
      const cwd = k && (k.foreground?.cwd ?? k.cwd);
      const r = cwd ? await exec("git", ["branch", "--show-current"], { cwd, on: spaces().find(s => s.active)?.machine }).catch(() => null) : null;
      const b = r?.code === 0 ? r.stdout.trim() || null : null;
      if (b !== this.chatBranch) { this.chatBranch = b; cx.notify(); }
    }));
  }

  context() {
    const space = spaces().find(s => s.active), f = focused();
    const terminal = terminals().find(k => k.state === "live" && (k.address === f?.terminal || (f?.pane && k.labels?.["herdr.chat"] === f.pane)));
    return { cwd: terminal?.foreground?.cwd || terminal?.cwd || f?.cwd || space?.folder, machine: space?.machine ?? null };
  }

  refreshApps(cx) {
    const context = this.context(), key = JSON.stringify(context);
    if (this.scanning === key || !context.cwd) return;
    this.scanning = key;
    cx.spawn(async cx => {
      try {
        const apps = await scanApps(context, this.apps);
        if (this.appKey === key) { this.apps = apps; this.appError = null; }
      } catch (e) {
        if (this.appKey === key) { this.apps = []; this.appError = String(e); }
      } finally {
        if (this.scanning === key) this.scanning = null;
      }
      cx.notify();
    });
  }

  launch(app, machine, cx) {
    if (this.opening) return;
    this.opening = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await openApp(app, machine);
        this.appsOpen = false;
      } catch (e) { notify({ title: "Couldn't open app", body: String(e), level: "error" }); }
      this.opening = false;
      cx.notify();
    });
  }

  setAppsOpen(open, machine, cx) {
    this.appsOpen = open;
    this.menuApps = null;
    this.menuError = null;
    cx.notify();
    if (!open) return;
    const apps = this.apps, key = this.appKey;
    cx.spawn(async cx => {
      try {
        const resolved = await appURLs(apps, machine);
        if (this.appKey === key) this.menuApps = resolved;
      } catch (e) { if (this.appKey === key) this.menuError = String(e); }
      cx.notify();
    });
  }

  appMenu(apps, machine) {
    const t = theme();
    return v_flex().w(460).mb(6).rounded(8).border(1).border_color(t.border).bg(t.popover).text_size(12.5)
      .child(h_flex().h(36).flex_none().px(14).items_center().text_color(t.muted).child(this.opening ? "Opening…" : "Open running app"))
      .child(v_flex().id("app-list").max_h(294).overflow_y_scrollbar().px(6).pb(6)
        .children((this.menuApps ?? apps).map(app => v_flex().id(`app-${app.port}`).h(48).flex_none().px(8).gap(3).justify_center().rounded(6)
          .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.launch(app, machine, cx))
          .child(div().font_medium().text_color(t.foreground).child(`Port ${app.port}`))
          .child(div().truncate().text_size(11).text_color(t.muted).child(app.browserUrl ?? (machine ? "Resolving Tailscale URL…" : app.url))))))
      .when(Boolean(this.menuError), el => el.child(div().px(14).pb(10).text_color(t.blocked).child(this.menuError)));
  }

  render(cx) {
    const context = this.context(), key = JSON.stringify(context);
    if (key !== this.appKey) {
      this.appKey = key;
      this.apps = [];
      this.appsOpen = false;
      this.menuApps = null;
      this.appError = null;
      this.refreshApps(cx);
    }
    const t = theme();
    const space = spaces().find(s => s.active);
    const branch = space?.branch ?? this.chatBranch;
    const list = [...agents(), ...chatAgents()];
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const appButton = h_flex().id("running-apps").gap(5).items_center().cursor_pointer()
      .text_color(t.ansi2).hover(s => s.text_color(t.foreground))
      .tooltip(context.machine ? "Open through Tailscale Serve" : "Open in browser")
      .child(div().size(6).rounded(3).bg(t.ansi2))
      .child(this.opening ? "Opening…" : this.apps.length === 1 ? `App :${this.apps[0].port}` : `${this.apps.length} apps ▴`);
    const appControl = this.apps.length > 1
      ? Popover.new("running-apps-popover").anchor("bottom_left").open(Boolean(this.appsOpen))
        .on_open_change((open, cx) => this.setAppsOpen(open, context.machine, cx))
        .trigger(appButton).content(this.appMenu(this.apps, context.machine))
      : appButton.on_click((_e, cx) => this.launch(this.apps[0], context.machine, cx));
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(branch), el => el.child(label("branch", branch)))
      .when(this.apps.length > 0, el => el.child(appControl))
      .when(Boolean(this.appError), el => el.child(div().text_color(t.dim).tooltip(this.appError).child("Apps unavailable")))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agent${list.length === 1 ? "" : "s"}`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))));
  }
}
