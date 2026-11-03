import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { exec as execFile, run, theme, props, closeOverlay, appHome, setShared } from "herdr";

// A popup from the tab bar: the Docker containers and volumes this space's worktree
// setup started (agent/worktree records them), with their state now. props: { folder }.
const HOOKS = () => `${appHome()}/agent/worktree`;
// Through a login shell, so OrbStack's or Docker Desktop's docker is on PATH.
const resources = (folder, action) =>
  execFile("/bin/zsh", ["-lc", 'exec "$0" resources "$1" "$2"', HOOKS(), folder, action ?? ""]);

// "127.0.0.1:22734->5432/tcp, [::]:..." -> the host ports, once each.
const hostPorts = (ports) => [...new Set([...(ports ?? "").matchAll(/:(\d+)->/g)].map((m) => m[1]))];

export default class Resources extends View {
  init(_props, cx) {
    this.data = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.act(null, cx);
  }

  // Lists them, or first stops, starts or removes all of them.
  act(action, cx) {
    this.busy = action ?? "loading";
    this.confirm = false;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await resources(props().folder, action).catch((e) => ({ code: 1, stderr: String(e) }));
      try { this.data = JSON.parse(r.stdout.trim().split("\n").pop()); this.error = null; }
      catch { this.error = r.stderr?.trim().split("\n").pop() || "Couldn't ask Docker."; }
      this.busy = null;
      // The tab bar's count follows.
      setShared("resources.changed", Date.now());
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const d = this.data;
    const running = d?.containers.filter((c) => c.state === "running").length ?? 0;
    const button = (id, label, action, danger = false) => h_flex().id(id).h(26).px(10).flex_none().items_center().rounded(6)
      .text_size(12).bg(danger ? t.blocked : t.raised).text_color(danger ? "#ffffff" : t.foreground)
      .when(!this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(action))
      .when(Boolean(this.busy), (el) => el.opacity(0.5)).child(label);
    const empty = d && !d.containers.length && !d.volumes.length;
    return v_flex().id("resources").w_full().bg(t.popover).text_size(12.5).text_color(t.foreground).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); } })
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/resources/container.svg").size(14).text_color(t.muted))
        .child(div().flex_1().font_semibold().child("Started by this worktree's setup"))
        .when(Boolean(d) && !empty, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`${running} of ${d.containers.length} running`))))
      // As tall as what it lists (a popup takes its content's height), scrolling past 280.
      .child(v_flex().id("list").max_h(280).p(6).gap(1).overflow_y_scrollbar()
        .when(!d && !this.error, (el) => el.child(div().p(8).text_color(t.dim).child("Asking Docker…")))
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_color(t.blocked).child(this.error)))
        .when(Boolean(empty), (el) => el.child(div().p(8).text_color(t.dim).child("Nothing. Its setup hasn't started any containers, or they were removed.")))
        .children((d?.containers ?? []).flatMap((c, i, all) => {
          const on = c.state === "running";
          // Each Compose stack's name, above its containers.
          const stack = c.project && c.project !== all[i - 1]?.project
            ? [div().px(8).pt(i ? 8 : 2).pb(2).text_size(11).font_medium().text_color(t.muted).child(c.project)] : [];
          return [...stack, h_flex().id(`c-${c.id}`).h(34).px(8).gap(8).flex_none().items_center().rounded(6).hover((s) => s.bg(t.hover))
            .child(div().size(7).flex_none().rounded(4).bg(on ? t.ansi2 : t.dim))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().child(c.service ?? c.name))
              .child(div().truncate().text_size(11).text_color(t.dim).child(c.status)))
            .children(hostPorts(c.ports).map((p) => div().flex_none().px(5).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(`:${p}`)))
            .child(div().id(`logs-${c.id}`).flex_none().px(6).py(2).rounded(4).text_size(11.5).text_color(t.muted).cursor_pointer()
              .hover((s) => s.bg(t.raised).text_color(t.foreground)).child("Logs")
              .on_click(() => { closeOverlay(props().overlay); run("pane.split", { direction: "down", argv: ["/bin/zsh", "-lc", 'exec docker logs -f --tail 200 "$0"', c.id] }); }))];
        }))
        .when((d?.volumes.length ?? 0) > 0, (el) => el.child(div().px(8).pt(8).pb(2).text_size(11).text_color(t.dim)
          .child(`Volumes: ${d.volumes.join(", ")}`))))
      .when(Boolean(d) && !empty, (el) => el.child(h_flex().h(46).flex_none().px(12).gap(6).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.confirm ? t.blocked : t.dim)
          .child(this.busy && this.busy !== "loading" ? `${this.busy[0].toUpperCase()}${this.busy.slice(1, -1)}ing…`
            : this.confirm ? "Removes the containers and volumes, and their data." : "Teardown removes them too."))
        .child(running ? button("stop", "Stop", (_e, cx) => this.act("stop", cx)) : button("start", "Start", (_e, cx) => this.act("start", cx)))
        .child(this.confirm
          ? button("remove-yes", "Remove all", (_e, cx) => this.act("remove", cx), true)
          : button("remove", "Remove…", (_e, cx) => { this.confirm = true; cx.notify(); }))));
  }
}
