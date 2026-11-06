// A thing's details as T3's thread card, with its timing: for Inbox rows and tabs. scripts/sync.sh copies this to the mods that use it.
import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

// The program's icon from the app's table: a one-color glyph or a picture.
export function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// As T3's tooltip group: while a card is up, or was under 400ms ago, the next opens at once.
export const detailsLive = (view) => Boolean(view.details) || Date.now() - (view.detailsClosed ?? 0) < 400;

// 150ms to the first card, which fades in; so does the last one out. What opens at once does so unfaded, as T3's.
// A transition adopts the first value it sees, so a card draws clear for a frame or two before its target changes.
export function detailsFor(view, key, cx) {
  view.detailsWait?.cancel();
  // Already closed by a press, the pointer's leaving mustn't stop the card's fade, or it stays up unseen.
  if (!key && !view.details) return;
  view.detailsFade?.cancel();
  if (!key) {
    view.detailsClosed = Date.now();
    view.detailsOut = view.details;
    view.details = null;
    view.detailsFade = cx.timer.after(150, (cx) => {
      view.detailsOut = null;
      cx.notify();
    });
    return;
  }
  const live = detailsLive(view);
  view.detailsOut = null;
  if (live) {
    view.details = key;
    view.detailsIn = true;
    return;
  }
  view.detailsWait = cx.timer.after(150, (cx) => {
    view.details = key;
    view.detailsIn = false;
    cx.notify();
    view.detailsWait = cx.timer.after(34, (cx) => {
      view.detailsIn = true;
      cx.notify();
    });
  });
}

export const detailsLine = (t, mark, text) => h_flex().gap(8).min_w(0).items_center().child(mark).child(div().min_w(0).truncate().text_color(t.foreground + "bf").child(text));

// The title, then its lines. The caller hangs it from a Popup and gives it its gap from what it describes.
// `wrap`: the title runs on over lines, for one the row it describes can't show whole (a commit's subject).
export const detailsCard = (view, t, key, title, lines, wrap) => v_flex().id(`details-card-${key}`).max_w(320).p(12).gap(8).rounded(6).border(1).border_color(t.border)
  // Solid: T3's glass blurs what's behind it, which a mod can't, and a terminal's text would show through.
  .bg(t.chrome).shadow_xl().text_size(12).opacity(view.details === key && view.detailsIn ? 1 : 0).transition("opacity", { duration: 150, easing: "ease-out" })
  .child(div().min_w(0).when(!wrap, el => el.truncate()).font_medium().text_color(t.foreground).child(title))
  .child(v_flex().pl(2).gap(6).children(lines.filter(Boolean)));
