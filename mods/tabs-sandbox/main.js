import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, exec as execFile, appHome } from "herdr";

// The branch to compare against: origin's default branch, else the usual names.
// ponytail: same lookup as changes-sandbox's Branch mode; mods can't import each other.
async function baseBranch(git) {
  const head = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const names = [head.code === 0 ? head.stdout.trim() : null, "origin/main", "origin/master", "main", "master"].filter(Boolean);
  for (const name of names) if ((await git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).code === 0) return name;
  return null;
}
// Reads write nothing under .git, like the Changes panel's.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // The containers this space's worktree setup started (mods/resources), counted.
    this.resources = { key: null, running: 0, total: 0 };
    // Lines added and removed on this space's branch, for the Changes button.
    this.branch = { key: null, add: 0, del: 0 };
    cx.timer.every(15000, (cx) => { if (window()?.active) { this.countResources(cx, true); this.countBranch(cx, true); } });
  }

  // Asked again when the space, its folder or its agents' status changes, and every
  // 15 seconds while the window is in front. Tracked files only, like `git diff`.
  countBranch(cx, force = false) {
    const space = spaces().find((p) => p.active);
    if (!space) return;
    const tabs = new Set((space.tabs ?? []).map((c) => c.id));
    const folder = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder, on = space.machine ?? null;
    const key = `${on}|${folder}|${space.status}`;
    if (!folder || (!force && key === this.branch.key) || this.branch.busy) return;
    this.branch.key = key; this.branch.busy = true;
    cx.spawn(async (cx) => {
      let stats = null;
      try {
        const git = (args) => execFile("git", [...READ, ...args], { cwd: folder, on });
        const base = await baseBranch(git);
        const mb = base && await git(["merge-base", base, "HEAD"]);
        const r = mb?.code === 0 && await git(["diff", mb.stdout.trim(), "--shortstat"]);
        if (r?.code === 0) stats = { add: +(/(\d+) insertion/.exec(r.stdout)?.[1] ?? 0), del: +(/(\d+) deletion/.exec(r.stdout)?.[1] ?? 0) };
      } catch {}
      this.branch = { key: this.branch.key, folder: `${on}|${folder}`, stats };
      cx.notify();
    });
  }

  // Asked again when the space (or its folder) changes, when the popup acted, and every
  // 15 seconds while the window is in front.
  countResources(cx, force = false) {
    const space = spaces().find((p) => p.active);
    if (!space || space.machine) return;
    const tabs = new Set((space.tabs ?? []).map((c) => c.id));
    const folder = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder;
    const key = `${folder}|${shared("resources.changed") ?? 0}`;
    if (!folder || (!force && key === this.resources.key)) return;
    this.resources.key = key;
    cx.spawn(async (cx) => {
      const r = await execFile("/bin/zsh", ["-lc", 'exec "$0" resources "$1"', `${appHome()}/agent/worktree`, folder]).catch(() => null);
      try {
        const d = JSON.parse(r.stdout.trim().split("\n").pop());
        this.resources = { key, folder, running: d.containers.filter((c) => c.state === "running").length, total: d.containers.length + d.volumes.length };
      } catch { this.resources = { key, folder, running: 0, total: 0 }; }
      cx.notify();
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(p => p.active);
    this.countResources(cx);
    this.countBranch(cx);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu-hooks", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon, tip) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).when(Boolean(tip), el => el.tooltip(tip)).child(svg(icon).size(14)).when(label !== null, el => el.child(label));
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu-sandbox", kind: "popup", width: 250, height: 543 })))
      // Only on a space whose worktree setup started something: how much is running.
      .when(this.resources.total > 0 && this.resources.key?.startsWith(`${this.resources.folder}|`), el => el.child(
        h_flex().id("resources").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).bg(t.chrome)
          .text_color(this.resources.running ? t.foreground : t.muted).hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
          .tooltip("Containers this worktree's setup started")
          .on_click(() => openOverlay({ mod: "resources", kind: "popup", width: 380, height: 380, props: { folder: this.resources.folder } }))
          .child(svg("mods/resources/container.svg").size(14))
          .child(div().size(6).rounded(3).bg(this.resources.running ? t.ansi2 : t.dim))
          .child(String(this.resources.running))))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => {
        // The branch's lines added and removed, once known for this space; just the icon otherwise.
        const stats = this.branch.key?.startsWith(`${this.branch.folder}|`) ? this.branch.stats : null;
        const label = stats && h_flex().gap(4).child(div().text_color(t.ansi2).child(`+${stats.add}`)).child(div().text_color(t.ansi1).child(`−${stats.del}`));
        return el.child(panelButton("changes", label, "mods/changes/changes.svg", "Changes on this branch"));
      })
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-sandbox/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-sandbox/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-sandbox/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
