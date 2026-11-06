import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { theme, props, closeOverlay, settings, home } from "herdr";
import { worktreeExec } from "./worktree-runtime.js";

// A window editing a repo's worktree setup and teardown: Herdr's own copy in
// ~/.config/herdr-app/worktrees/, read and written through agent/worktree so the file's
// place and format live in one script. props: { folder, machine } (any checkout).
const tilde = (p) => (p?.startsWith(home()) ? `~${p.slice(home().length)}` : p);

export default class WorktreeSetup extends View {
  init(_props, cx) {
    // A window doesn't take the keyboard when it opens: without this, Escape and the
    // rest go to the terminal behind it.
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    const t = theme();
    const editor = (language) => EditorState.new({ language, value: "", font_family: settings().font_family, font_size: 12, folding: false,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    this.copy = editor("text");
    this.setup = editor("bash");
    this.teardown = editor("bash");
    for (const e of [this.copy, this.setup, this.teardown]) e.on("change", (_e, cx) => { this.dirty = true; this.status = null; cx.notify(); });
    cx.spawn(async (cx) => {
      const r = await worktreeExec("config", props().folder, [], props().machine).catch((e) => ({ code: 1, stderr: String(e) }));
      try {
        const c = JSON.parse(r.stdout);
        this.config = c;
        this.copy.set_value(c.copy.join("\n"));
        this.setup.set_value(c.setup);
        this.teardown.set_value(c.teardown);
        this.dirty = false;
      } catch { this.status = { error: true, text: r.stderr?.trim() || "Couldn't read this repo's worktree setup." }; }
      cx.notify();
    });
  }

  save(cx) {
    const body = { copy: this.copy.value().split("\n"), setup: this.setup.value(), teardown: this.teardown.value() };
    cx.spawn(async (cx) => {
      const r = await worktreeExec("save", props().folder, [JSON.stringify(body)], props().machine).catch((e) => ({ code: 1, stderr: String(e) }));
      this.status = r.code === 0 ? { text: "Saved. New worktrees use it; Enter in a Setup pane reruns it." } : { error: true, text: r.stderr.trim() || "Couldn't save." };
      if (r.code === 0) this.dirty = false;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const c = this.config;
    // Presses on controls stay theirs; anywhere else drags the window.
    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const button = (id, label, primary, action) => stop(h_flex().id(id).h(30).px(14).flex_none().items_center().rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(label));
    const section = (id, title, hint, state, grow) => v_flex().gap(6).when(grow, (el) => el.flex_1()).min_h(0)
      .child(h_flex().gap(8).items_baseline()
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(hint)))
      .child(stop(div().id(id).when(grow, (el) => el.flex_1()).when(!grow, (el) => el.h(76)).min_h(0).rounded(8).border_1().border_color(t.input)
        .bg(t.background).overflow_hidden().child(Editor.new(state))));
    return v_flex().size_full().bg(t.popover).text_color(t.foreground).track_focus(this.handle)
      // Escape closes it; ⌘S saves. Keys typed in an editor reach here too.
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); }
        else if (e.modifiers?.platform && e.key === "s") { cx.stop_propagation(); this.save(cx); }
      })
      .child(h_flex().h(44).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/git-branch.svg").size(14).text_color(t.muted))
        .child(div().text_size(13.5).font_semibold().child(`Worktree setup${c ? ` · ${c.repo.split("/").pop()}` : ""}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(c ? tilde(c.file) : ""))
        .child(stop(div().id("close").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props().overlay))
          .child(svg("mods/workspace-chrome/x.svg").size(14)))))
      .child(v_flex().flex_1().min_h(0).p(16).gap(14)
        .child(section("copy", "Copy into new worktrees", "one path per line, from the main checkout", this.copy, false))
        .child(section("setup", "Setup", "runs in a new worktree's Setup pane, before its agent", this.setup, true))
        .child(section("teardown", "Teardown", "runs in the worktree before Remove worktree deletes it", this.teardown, true)))
      .child(h_flex().h(54).flex_none().px(16).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.status?.error ? t.blocked : t.dim)
          .child(this.status?.text ?? (this.dirty ? "Unsaved changes" : "Runs outside the sandbox, in your shell.")))
        .child(button("cancel", "Close", false, () => closeOverlay(props().overlay)))
        .child(button("save", "Save", true, (_e, cx) => this.save(cx))));
  }
}
