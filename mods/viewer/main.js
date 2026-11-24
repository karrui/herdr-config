// Text files beside the terminals, each in a tab of this pane: markdown rendered, the rest
// read-only with syntax colors. One viewer per tab; open.js sends it files (chat file links,
// terminal Cmd-clicks).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, shared, setShared, theme, settings, readTextFile, panes, run } from "herdr";
import { openInViewer, openExternal } from "./open.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", sh: "bash", zsh: "bash" };
const MARKDOWN = /\.(md|markdown|mdx)$/i;
// Longer files show their start: the editor slows down well before this.
const MAX = 400000;
const base = (p) => p.split("/").pop();
const same = (a, b) => a.path === b.path && (a.on ?? null) === (b.on ?? null);
// Long lines wrap unless turned off; one choice for every viewer.
const wrapping = () => shared("viewer.wrap") !== false;

export default class Viewer extends View {
  init(_props, cx) {
    const P = props() ?? {};
    this.tab = P.tab;
    // Requests already there belong to viewers before this one.
    this.seen = shared("viewer.open")?.n ?? 0;
    this.docs = [];
    this.active = 0;
    this.wrapped = wrapping();
    if (P.file) this.open(P.file, cx);
    // Agents rewrite what they show: the open file follows (this computer's only).
    cx.timer.every(2000, (cx) => { const d = this.docs[this.active]; if (d && !d.on && d.text != null) this.load(d, cx, true); });
  }

  open(file, cx) {
    const at = this.docs.findIndex((d) => same(d, file));
    if (at >= 0) {
      this.active = at;
      if (file.line) { this.docs[at].line = file.line; this.toLine(this.docs[at]); }
    } else {
      this.docs.push({ path: file.path, on: file.on ?? null, line: file.line ?? null, md: MARKDOWN.test(file.path), text: null, error: null, code: null });
      this.active = this.docs.length - 1;
      this.load(this.docs[this.active], cx);
    }
    cx.notify();
  }

  load(doc, cx, quiet = false) {
    cx.spawn(async (cx) => {
      try {
        let text = await readTextFile(doc.path, { on: doc.on });
        if (text === null) { if (!quiet) doc.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { doc.error = "Binary file · no text preview"; return; }
        if (text.length > MAX) text = text.slice(0, MAX) + "\n… (file truncated)";
        if (text === doc.text) return;
        doc.text = text; doc.error = null;
        if (doc.md) return;
        if (doc.code) { doc.code.set_value(text); return; }
        this.edit(doc);
        this.toLine(doc);
      } catch (e) { if (!quiet) doc.error = `Cannot show this file: ${e?.message ?? e}`; }
      finally { if (this.docs.includes(doc)) cx.notify(); }
    });
  }

  // A code view of the document, wrapping as chosen. Wrapping is fixed when the view is made:
  // a change makes it again, the cursor kept where it was.
  edit(doc) {
    const t = theme(), ext = doc.path.includes(".") ? doc.path.split(".").pop().toLowerCase() : "txt", at = doc.code?.selected_range();
    doc.code?.release();
    doc.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value: doc.text, soft_wrap: this.wrapped,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    if (at) doc.code.set_selected_range(at);
  }

  // The cursor on the clicked line, which brings it into view.
  toLine(doc) {
    if (!doc.code || !doc.line || doc.text == null) return;
    const lines = doc.text.split("\n").slice(0, doc.line - 1);
    const at = lines.reduce((n, l) => n + l.length + 1, 0);
    doc.code.set_selected_range({ start: at, end: at });
  }

  close(i, cx) {
    const [doc] = this.docs.splice(i, 1);
    doc?.code?.release();
    if (!this.docs.length) {
      const me = panes().find((p) => p.mod === "viewer" && p.tab === this.tab)?.pane;
      if (me) run("pane.close", { pane: me });
      return;
    }
    if (this.active >= i) this.active = Math.max(0, this.active - 1);
    cx.notify();
  }

  // A link in a rendered document: a file next to it opens here, the rest outside.
  follow(url, doc, cx) {
    if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^file:/i.test(url)) { if (!doc.on) openExternal(url).catch(() => {}); return; }
    let path = decodeURIComponent(url.replace(/^file:\/\/[^/]*/i, "").replace(/#.*$/, ""));
    if (!path) return;
    if (!path.startsWith("/")) {
      const parts = doc.path.split("/").slice(0, -1);
      for (const part of path.split("/")) { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); }
      path = parts.join("/");
    }
    const me = panes().find((p) => p.mod === "viewer" && p.tab === this.tab)?.pane;
    cx.spawn(async () => {
      if (!me || !(await openInViewer({ path, on: doc.on, pane: me }))) { if (!doc.on) openExternal(path).catch(() => {}); }
    });
  }

  render(cx) {
    const req = shared("viewer.open");
    if (req?.n > this.seen && req.tab === this.tab) { this.seen = req.n; this.open(req.file, cx); }
    if (this.wrapped !== wrapping()) {
      this.wrapped = wrapping();
      cx.spawn(async (cx) => { for (const d of this.docs) if (d.code) this.edit(d); cx.notify(); });
    }
    const t = theme(), doc = this.docs[this.active];
    return v_flex().id("viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().id("viewer-tabs").h(36).flex_none().px(6).gap(2).items_center().overflow_x_scroll().border_b(1).border_color(t.border)
        .children(this.docs.map((d, i) => h_flex().id(`viewer-tab-${i}`).h(26).flex_none().pl(10).pr(4).gap(4).items_center().rounded(6).cursor_pointer()
          .text_size(12.5).when(i === this.active, (el) => el.bg(t.hover).text_color(t.foreground))
          .when(i !== this.active, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .tooltip(d.on ? `${d.on}:${d.path}` : d.path)
          .on_click((_e, cx) => { this.active = i; cx.notify(); })
          .child(div().max_w(200).truncate().child(base(d.path)))
          .child(div().id(`viewer-close-${i}`).w(18).h(18).flex().items_center().justify_center().rounded(4).text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.close(i, cx); })
            .child(svg("mods/viewer/x.svg").size(12)))))
        .child(div().flex_1())
        .when(Boolean(doc?.code), (el) => el.child(div().id("viewer-wrap").w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .when(this.wrapped, (el) => el.bg(t.hover).text_color(t.foreground)).when(!this.wrapped, (el) => el.text_color(t.dim))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(this.wrapped ? "Don't wrap long lines" : "Wrap long lines")
          .on_click((_e, cx) => { setShared("viewer.wrap", !this.wrapped); cx.notify(); })
          .child(svg("mods/viewer/wrap.svg").size(14)))))
      .child(!doc ? div().flex_1()
        : doc.error ? div().p(16).text_color(t.dim).child(doc.error)
        : doc.text == null ? div().p(16).text_color(t.dim).child("Loading…")
        : doc.md ? div().id(`viewer-md-${this.active}`).flex_1().min_h(0).overflow_y_scrollbar()
          .child(div().w_full().max_w(860).mx_auto().px(28).py(20)
            .child(TextView.markdown(`viewer-md-text-${doc.path}`, doc.text).selectable(true).on_link_click((url, cx) => this.follow(url, doc, cx))))
        : !doc.code ? div().p(16).text_color(t.dim).child("Loading…")
        : Editor.new(doc.code).font_family(settings().font_family).text_size(settings().font_size).flex_1().min_h(0));
  }
}
