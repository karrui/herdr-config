import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { theme, props, closeOverlay, appHome, settings, readTextFile, writeTextFile } from "herdr";

// A window editing what sandboxed agents may use (sandbox/allow.txt) and what they never
// may (sandbox/deny.txt); sandbox/agent-sandbox reads both when an agent starts.
const DIR = () => `${appHome()}/sandbox`;
const FILES = { allow: "allow.txt", deny: "deny.txt" };

// The first line that isn't a comment, a blank or what that list takes, as "line N: …".
function problem(kind, text) {
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n].trim();
    if (!l || l.startsWith("#")) continue;
    if (kind === "allow" && !/^(rw|ro)\s+\S/.test(l)) return `Allow, line ${n + 1}: start it with rw or ro, then the path.`;
    if (kind === "deny" && /^(rw|ro)\s/.test(l)) return `Deny, line ${n + 1}: just the path, no rw or ro.`;
  }
  return null;
}

export default class SandboxLists extends View {
  init(_props, cx) {
    // A window doesn't take the keyboard when it opens: without this, Escape and the
    // rest go to the terminal behind it.
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    const editor = () => EditorState.new({ language: "text", value: "", font_family: settings().font, font_size: 12, folding: false, soft_wrap: true });
    this.allow = editor();
    this.deny = editor();
    this.loaded = {};
    for (const kind of ["allow", "deny"]) this[kind].on("change", (_e, cx) => { this.dirty = true; this.status = null; cx.notify(); });
    cx.spawn(async (cx) => {
      for (const kind of ["allow", "deny"]) {
        this.loaded[kind] = await readTextFile(`${DIR()}/${FILES[kind]}`);
        this[kind].set_value(this.loaded[kind] ?? "");
      }
      this.dirty = false;
      cx.notify();
    });
  }

  save(cx) {
    const texts = { allow: this.allow.value(), deny: this.deny.value() };
    const bad = problem("allow", texts.allow) ?? problem("deny", texts.deny);
    if (bad) { this.status = { error: true, text: bad }; return cx.notify(); }
    cx.spawn(async (cx) => {
      try {
        for (const kind of ["allow", "deny"]) {
          const text = texts[kind].replace(/\n*$/, "\n");
          if (text === this.loaded[kind]) continue;
          // Refused if the file changed since it was read (the blocked list adds to allow.txt).
          await writeTextFile(`${DIR()}/${FILES[kind]}`, text, this.loaded[kind] ?? null);
          this.loaded[kind] = text;
        }
        this.dirty = false;
        this.status = { text: "Saved. Agents started from now on use it; running ones keep theirs until they restart." };
      } catch {
        this.status = { error: true, text: "A list changed while this was open. Close and reopen to see it, then edit again." };
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const button = (id, label, primary, action) => stop(h_flex().id(id).h(30).px(14).flex_none().items_center().rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(label));
    const section = (id, title, hint, state, height) => v_flex().gap(6).min_h(0).when(!height, (el) => el.flex_1()).when(Boolean(height), (el) => el.h(height))
      .child(h_flex().gap(8).items_baseline()
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(hint)))
      .child(stop(div().id(id).flex_1().min_h(0).rounded(8).border_1().border_color(t.input).bg(t.background).overflow_hidden()
        .child(Editor.new(state))));
    return v_flex().size_full().bg(t.popover).text_color(t.foreground).track_focus(this.handle)
      // Escape closes it; ⌘S saves. Keys typed in an editor reach here too.
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); }
        else if (e.modifiers?.platform && e.key === "s") { cx.stop_propagation(); this.save(cx); }
      })
      .child(h_flex().h(44).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/agent-bar/shield.svg").size(14).text_color(t.muted))
        .child(div().text_size(13.5).font_semibold().child("Sandbox lists"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child("~/.config/herdr-app/sandbox"))
        .child(stop(div().id("close").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props().overlay))
          .child(svg("mods/workspace-chrome/x.svg").size(14)))))
      .child(v_flex().flex_1().min_h(0).p(16).gap(14)
        .child(div().text_size(12).text_color(t.dim).child("A sandboxed agent can't read your home folder or write anywhere, except the folder it starts in and what Allow lists. Deny wins over both."))
        .child(section("allow", "Allow", "rw <path> to read and write, ro <path> to read; a folder takes what's in it", this.allow, 0))
        .child(section("deny", "Deny", "one path per line, never readable or writable", this.deny, 150)))
      .child(h_flex().h(54).flex_none().px(16).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.status?.error ? t.blocked : t.dim)
          .child(this.status?.text ?? (this.dirty ? "Unsaved changes" : "Agents pick up changes when they next start.")))
        .child(button("cancel", "Close", false, () => closeOverlay(props().overlay)))
        .child(button("save", "Save", true, (_e, cx) => this.save(cx))));
  }
}
