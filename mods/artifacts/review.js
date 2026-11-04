// Approving an artifact before it runs. An artifact is a mod: Herdr runs it outside any sandbox,
// with everything a mod may do (exec). herdr-artifact installs only files whose hash the person
// approved (or that an unsandboxed agent published), so opening one that isn't asks here: its
// files, whole, then Approve and open. Opened by openReview() as this mod with props.review =
// { art: { id, title, version, latest, machine }, area }; artview.js does it when a pull says
// "needs approval".

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, closeOverlay, settings } from "herdr";
import { artifactCli as cli, openViewer } from "./artview.js";
import { plainError } from "./ui.js";

export class Review {
  constructor(view, cx) {
    this.view = view;
    this.files = null;
    this.error = null;
    this.busy = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const a = props().review.art;
    cx.spawn(async (cx) => {
      try {
        const v = a.latest && a.version && a.version < a.latest ? ["--version", String(a.version)] : [];
        this.info = await cli(a.machine ?? null, ["review", a.id, ...v]);
        this.files = this.info.files;
      } catch (e) {
        this.error = plainError(e);
      }
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  approve(cx) {
    if (this.busy || !this.info) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      const { art, area } = props().review;
      try {
        const v = this.info.version !== (art.latest ?? art.version) ? ["--version", String(this.info.version)] : [];
        await cli(art.machine ?? null, ["approve", art.id, ...v, "--sha", this.info.sha]);
        this.close();
        openViewer(art, area);
      } catch (e) {
        this.error = plainError(e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  button(id, label, primary, action) {
    const t = theme();
    return h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(6).text_size(12.5).font_medium().cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => action(cx)).child(label);
  }

  render(cx) {
    const t = theme();
    const a = props().review.art;
    const mono = settings()?.font_family ?? "JetBrains Mono";
    const file = (f) => v_flex().w_full().flex_none().gap(4)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12).font_medium().text_color(t.foreground).child(f.path))
        .child(div().text_size(11.5).text_color(t.dim).child(`${f.size} bytes`)))
      .child(div().w_full().p(10).rounded(6).bg(t.background).border_1().border_color(t.border)
        .font_family(mono).text_size(11.5).text_color(f.text === null ? t.dim : t.foreground).whitespace_normal()
        .child(f.text === null ? "Not text, or too big to show: read it in its folder before approving." : f.text));
    return v_flex().id("review").track_focus(this.handle).size_full().bg(t.popover).text_size(13)
      .on_key_down((e) => { if (e.key === "escape") this.close(); })
      .child(v_flex().flex_none().px(16).pt(14).pb(12).gap(6).border_b(1).border_color(t.border)
        .child(div().font_semibold().text_color(t.foreground).child(`Approve “${a.title ?? a.id}” before it runs?`))
        .child(div().text_size(12.5).text_color(t.muted).child(
          "An agent in the sandbox made this artifact. Artifacts run outside the sandbox, as part of Herdr, and can do anything Herdr can, such as run commands. Read what it does first. This version stays approved; a new one asks again.")))
      .child(v_flex().id("review-files").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(14)
        .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
        .when(this.files === null && !this.error, (el) => el.child(div().text_color(t.dim).child("Reading its files…")))
        .children((this.files ?? []).map(file)))
      .child(h_flex().flex_none().h(52).px(16).gap(8).items_center().justify_end().border_t(1).border_color(t.border)
        .child(this.button("review-cancel", "Cancel", false, () => this.close()))
        .when(Boolean(this.info), (el) => el.child(this.button("review-ok", this.busy ? "Approving…" : "Approve and open", true, (cx) => this.approve(cx)))));
  }
}
