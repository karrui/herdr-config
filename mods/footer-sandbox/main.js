// The sidebar's footer (workspace-chrome's, cloned): Usage, which opens Claude's and
// Codex's plan limits (mods/usage), above Settings and Add machine.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, updates, openOverlay } from "herdr";

export default class Footer extends View {
  render() {
    const t = theme();
    const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
      .text_color(dim ? t.dim : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_click(action).child(svg(icon).size(14)).child(label);
    return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
      // Beside the row, from its top; kept in the window, it ends at the window's bottom.
      .child(row("usage", "mods/usage/gauge.svg", "Usage", false, () => openOverlay({ mod: "usage", kind: "popup", width: 300, height: 480,
        ...(this.usageAt ? { at: this.usageAt } : {}) }))
        .on_mouse_down("left", (e) => { if (e.bounds) this.usageAt = { x: e.bounds.x + e.bounds.width + 14, y: e.bounds.y }; }))
      .child(row("settings", "mods/workspace-chrome/settings.svg", "Settings", false, () => run("app.settings"))
        .when(Boolean(updates().app.ready), (el) => el.child(div().size(6).rounded_full().bg(t.accent))))
      .child(row("machine", "mods/workspace-chrome/plus.svg", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
  }
}
