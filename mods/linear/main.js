// The Linear ticket for the focused pane's branch: linked by hand, else named in the
// branch (devx-684-fix → DEVX-684, when DEVX is a team), else the issue Linear itself
// ties to that branch name.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { spaces, panes, focused, exec as execFile, readTextFile, writeTextFile, shared, setShared, theme } from "herdr";
import * as fs from "fs/promises";
import { KEY_DIR, KEY_FILE, KEY_CHANGED, LINKS, ID, readKey, linear, findTicket } from "./resolve.js";

const KEYS_URL = "https://linear.app/settings/account/security";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, branch: pane?.branch ?? space?.branch ?? null, on: space?.machine ?? null };
}
const key = () => JSON.stringify(location());

export default class LinearPanel extends View {
  init(_props, cx) {
    this.apiKey = null; this.keyLoaded = false; this.editingKey = false; this.issue = null; this.status = "loading";
    this.keyInput = InputState.new({ placeholder: "Paste a Linear personal API key" });
    this.linkInput = InputState.new({ placeholder: "Link a ticket: DEVX-684 or its URL" });
    this.keyInput.on("submit", (_e, cx) => this.saveKey(cx));
    this.linkInput.on("submit", (_e, cx) => this.link(cx));
    cx.spawn(async (cx) => {
      this.apiKey = await readKey();
      this.keyLoaded = true;
      this.refresh(cx, true);
    });
    // Titles and states change in Linear, not here.
    cx.timer.every(60000, (cx) => this.refresh(cx, true));
  }

  refresh(cx, force = false) {
    const context = key();
    if (!this.keyLoaded || (!force && context === this.context)) return;
    this.context = context;
    if (!this.apiKey) { this.status = "no-key"; this.issue = null; return cx.notify(); }
    const { cwd, branch, on } = location();
    if (!cwd) { this.status = "none"; this.issue = null; return cx.notify(); }
    const run = (this.run ?? 0) + 1;
    this.run = run;
    if (!this.issue) this.status = "loading";
    cx.notify();
    cx.spawn(async (cx) => {
      const current = () => this.run === run && key() === context;
      try {
        const found = await findTicket(this.apiKey, { cwd, branch, on });
        if (!current()) return;
        this.status = found.status; this.issue = found.issue ?? null; this.source = found.source;
        this.repo = found.repo ?? null; this.branch = found.branch ?? null; this.error = null;
      } catch (e) {
        if (!current()) return;
        this.error = String(e.message ?? e);
        this.status = e.auth ? "no-key" : "error";
        if (e.auth) this.issue = null;
      } finally { if (current()) cx.notify(); }
    });
  }

  saveKey(cx) {
    const value = this.keyInput.value().trim();
    if (!value) return;
    this.keyInput.set_value("");
    cx.spawn(async (cx) => {
      try {
        await linear(value, "{ viewer { id } }");
        await fs.mkdir(KEY_DIR(), { recursive: true });
        const old = await readTextFile(KEY_FILE()).catch(() => null);
        await writeTextFile(KEY_FILE(), `${value}\n`, old ?? null);
        await execFile("chmod", ["600", KEY_FILE()]);
        this.apiKey = value; this.editingKey = false; this.error = null;
        setShared(KEY_CHANGED, Date.now());
        this.refresh(cx, true);
      } catch (e) { this.error = String(e.message ?? e); this.status = "no-key"; cx.notify(); }
    });
  }

  setLink(value, cx) {
    if (!this.repo || !this.branch) return;
    const links = { ...(shared(LINKS) ?? {}) }, k = `${this.repo}|${this.branch}`;
    if (value === null) delete links[k]; else links[k] = value;
    setShared(LINKS, links);
    this.issue = null;
    this.refresh(cx, true);
  }

  link(cx) {
    // A URL's id follows /issue/; its slug can look like one too (…/some-title-2).
    const text = this.linkInput.value();
    const id = /\/issue\/([a-z][a-z0-9]{0,9}-\d+)/i.exec(text)?.[1] ?? [...text.matchAll(ID)][0]?.[1];
    if (!id) { this.error = "That isn't a ticket id or Linear URL"; return cx.notify(); }
    this.linkInput.set_value("");
    this.setLink(id.toUpperCase(), cx);
  }

  button(id, label, t, action, solid = false) {
    return div().id(id).h(28).px(10).flex().flex_none().items_center().rounded(7).cursor_pointer().text_size(12)
      .bg(solid ? t.solid : t.raised).text_color(solid ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => action(cx)).child(label);
  }

  field(id, input, t, submit, label) {
    return h_flex().gap(8)
      .child(div().id(id).flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.border).cursor_text()
        .child(Input.new(input).h_full().text_size(12).text_color(t.foreground)))
      .child(this.button(`${id}-go`, label, t, submit, true));
  }

  setup(t) {
    return v_flex().p(14).gap(10).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child("Connect Linear"))
      .child(div().child("Create a personal API key in Linear, then paste it here. It's kept in Herdr's folder, which sandboxed agents can't read."))
      .child(div().id("keys-url").text_color(t.accent).cursor_pointer().on_click(() => execFile("open", [KEYS_URL])).child("Open Linear's API key settings"))
      .child(this.field("key", this.keyInput, t, (cx) => this.saveKey(cx), "Save"))
      .when(Boolean(this.apiKey), (e) => e.child(div().id("key-cancel").text_size(12).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.editingKey = false; this.error = null; cx.notify(); }).child("Keep the current key")));
  }

  ticket(issue, t) {
    const meta = [issue.assignee?.name ?? "Unassigned", issue.priorityLabel, issue.project?.name].filter(Boolean).join("  ·  ");
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).pt(12).pb(10).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(12).text_color(t.muted).child(issue.identifier))
          .child(h_flex().h(20).px(7).gap(5).items_center().rounded(10).border_1().border_color(t.border).text_size(11)
            .child(div().size(7).rounded(4).bg(issue.state?.color ?? t.dim)).child(issue.state?.name ?? ""))
          .child(div().flex_1())
          .child(this.button("open", "Open in Linear", t, () => execFile("open", [issue.url]))))
        .child(div().text_size(15).font_semibold().child(issue.title))
        .child(div().text_size(12).text_color(t.muted).child(meta))
        .when(issue.labels?.nodes?.length > 0, (e) => e.child(h_flex().flex_wrap().gap(5).children(issue.labels.nodes.map((l, i) =>
          h_flex().id(`label-${i}`).h(20).px(7).gap(5).items_center().rounded(10).border_1().border_color(t.border).text_size(11)
            .child(div().size(7).rounded(4).bg(l.color)).child(l.name))))))
      .child(div().id("description").flex_1().min_h(0).px(14).py(10).overflow_y_scrollbar().text_size(13)
        .child(issue.description?.trim() ? TextView.markdown("description-md", issue.description.slice(0, 20000)).selectable(true)
          : div().text_color(t.dim).child("No description")));
  }

  render(cx) {
    this.refresh(cx);
    const t = theme(), issue = this.status === "issue" ? this.issue : null;
    const linked = this.source === "linked";
    const message = {
      loading: "Loading…",
      none: "No folder",
      "no-repo": "Not a git repository",
      "no-branch": "Not on a branch",
      "not-found": `No Linear ticket for ${this.branch}. Link one below.`,
      unlinked: `Unlinked from ${this.branch}. Link a ticket below, or go back to detecting it from the branch.`,
      error: this.error,
    }[this.status];
    const setup = this.keyLoaded && (this.status === "no-key" || this.editingKey);
    const canLink = !setup && this.apiKey && this.repo && this.branch && !["no-repo", "no-branch", "none", "no-key"].includes(this.status);
    return v_flex().id("linear").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/linear/ticket.svg").size(14).text_color(t.muted))
        .child(div().font_semibold().child("Linear"))
        .when(Boolean(issue), (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(linked ? "Linked" : "From branch"))))
      .when(setup, (e) => e.child(this.setup(t)))
      .when(!setup && Boolean(issue), (e) => e.child(this.ticket(issue, t)))
      .when(!setup && !issue, (e) => e.child(div().flex_1().p(14).text_color(t.dim).child(message ?? "")))
      .when(setup && Boolean(this.error), (e) => e.child(div().px(14).text_size(12).text_color(t.ansi1).child(this.error)))
      .when(Boolean(canLink), (e) => e.child(v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .when(this.status !== "error" && Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
        .child(this.field("link", this.linkInput, t, (cx) => this.link(cx), "Link"))
        .child(h_flex().gap(12).text_size(11).text_color(t.dim)
          .when(Boolean(issue) && !linked, (e) => e.child(div().id("unlink").cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setLink("", cx)).child("Not this ticket")))
          .when(linked || this.status === "unlinked", (e) => e.child(div().id("auto").cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setLink(null, cx)).child("Detect from branch")))
          .child(div().flex_1())
          .child(div().id("change-key").cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.editingKey = true; this.error = null; cx.notify(); }).child("API key")))));
  }
}
