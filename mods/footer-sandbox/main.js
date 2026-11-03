// The sidebar's footer (workspace-chrome's, cloned): Usage, which opens Claude's and
// Codex's plan limits (mods/usage), above Settings and Add machine.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, updates } from "herdr";

export default class Footer extends View {
  render() {
    const t = theme();
    const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
      .text_color(dim ? t.dim : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_click(action).child(svg(icon).size(14)).child(label);
    return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
      .child(row("usage", "mods/usage/gauge.svg", "Usage", false, () => run("mod.open", { name: "usage" })))
      .child(row("settings", "mods/workspace-chrome/settings.svg", "Settings", false, () => run("app.settings"))
        .when(Boolean(updates().app.ready), (el) => el.child(div().size(6).rounded_full().bg(t.accent))))
      .child(row("machine", "mods/workspace-chrome/plus.svg", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
  }
}
