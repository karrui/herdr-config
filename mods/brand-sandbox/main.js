// The sidebar's top bar: workspace-chrome's, without Herdr's logo and name or the sidebar
// toggle (the layout's sidebar doesn't fold to a rail). Search stays on the right; the bar
// still moves the window (the layout's window_drag), and on macOS leaves the traffic
// lights their room.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window } from "herdr";

export default class Brand extends View {
  render() {
    const t = theme();
    return h_flex().size_full().bg(t.chrome).pl(14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen, el => el.pl(76))
      .child(div().flex_1())
      .child(div().id("search").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run("mod.open", { name: "picker" }))
        .child(svg("mods/workspace-chrome/search.svg").size(15)));
  }
}
