// The Linear ticket for the focused pane's branch: linked by hand, else named in the
// branch (devx-684-fix → DEVX-684, when DEVX is a team), else the issue Linear itself
// ties to that branch name. Opened as an overlay it is the Linear button's right-click
// menu ({view: "menu", repo, branch, issue, source}), the link dialog ({view: "link",
// repo, branch}) or the API key dialog ({view: "key"}).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { spaces, panes, focused, exec as execFile, readTextFile, writeTextFile, shared, setShared, theme, props, openOverlay, closeOverlay } from "herdr";
import * as fs from "fs/promises";
import { KEY_DIR, KEY_FILE, KEY_CHANGED, LINKS, readKey, linear, findTicket, setLink, parseId } from "./resolve.js";

const KEYS_URL = "https://linear.app/settings/account/security";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, branch: pane?.branch ?? space?.branch ?? null, on: space?.machine ?? null };
}
// A link made from the button's menu shows here at once.
const key = () => JSON.stringify([location(), shared(LINKS) ?? null]);

export function openLinkDialog(repo, branch) {
  openOverlay({ mod: "linear", kind: "dialog", width: 420, props: { view: "link", repo, branch } });
}
export function openKeyDialog() {
  openOverlay({ mod: "linear", kind: "dialog", width: 420, props: { view: "key" } });
}

export default class LinearPanel extends View {
  init(_props, cx) {
    this.view = props()?.view ?? "panel";
    this.apiKey = null; this.keyLoaded = false; this.issue = null; this.status = "loading";
    this.keyInput = InputState.new({ placeholder: "Paste a Linear personal API key" });
    this.keyInput.set_masked(true);
    this.linkInput = InputState.new({ placeholder: "DEVX-684 or its Linear URL" });
    this.keyInput.on("submit", (_e, cx) => this.saveKey(cx));
    this.linkInput.on("submit", (_e, cx) => this.link(cx));
    if (this.view === "link") this.linkInput.focus();
    if (this.view === "key") this.keyInput.focus();
    if (this.view !== "panel") return;
    cx.spawn(async (cx) => {
      this.apiKey = await readKey();
      this.keyLoaded = true;
      this.refresh(cx, true);
      cx.notify();
    });
    // Titles and states change in Linear, not here.
    cx.timer.every(60000, (cx) => this.refresh(cx, true));
  }

  refresh(cx, force = false) {
    if (this.view !== "panel") return;
    const context = key();
    if (!this.keyLoaded || (!force && context === this.context)) return;
    // Another branch: its ticket isn't the one shown. A timed refresh keeps it until it's back.
    const moved = context !== this.context;
    this.context = context;
    const { cwd, branch, on } = location();
    const run = (this.run ?? 0) + 1;
    this.run = run;
    // Runs from render too, where cx.notify() isn't allowed, and a task runs in its caller
    // until its first await: what changes now isn't announced (render draws it next; an
    // event handler calling this notifies), and the task notifies only after awaiting.
    if (!this.apiKey) { this.status = "no-key"; this.issue = null; return; }
    if (!cwd) { this.status = "none"; this.issue = null; return; }
    if (moved || !this.issue) { this.status = "loading"; this.issue = null; }
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
        setShared(KEY_CHANGED, Date.now());
        if (this.view === "key") return closeOverlay(props().overlay);
        this.apiKey = value; this.error = null;
        this.refresh(cx, true);
        cx.notify();
      } catch (e) { this.error = String(e.message ?? e); if (this.view === "panel") this.status = "no-key"; cx.notify(); }
    });
  }

  // The panel links to the branch it shows; the dialog to the one it was opened for.
  link(cx) {
    const id = parseId(this.linkInput.value());
    if (!id) { this.error = "That isn't a ticket id or Linear URL"; return cx.notify(); }
    const { repo, branch } = this.view === "link" ? props() : this;
    if (!repo || !branch) return;
    this.linkInput.set_value("");
    setLink(repo, branch, id);
    if (this.view === "link") return closeOverlay(props().overlay);
    this.error = null;
    this.refresh(cx, true);
    cx.notify();
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

  setup(t, cancel) {
    return v_flex().gap(10).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child(cancel ? "Linear API key" : "Connect Linear"))
      .child(div().child("Create a personal API key in Linear, then paste it here. It's kept in Herdr's folder, which sandboxed agents can't read."))
      .child(div().id("keys-url").text_color(t.accent).cursor_pointer().on_click(() => execFile("open", [KEYS_URL])).child("Open Linear's API key settings"))
      .child(this.field("key", this.keyInput, t, (cx) => this.saveKey(cx), "Save"))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .when(Boolean(cancel), (e) => e.child(div().id("key-cancel").text_size(12).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => cancel(cx)).child("Keep the current key")));
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

  // The Linear button's right-click menu.
  menu(t) {
    const { repo, branch, issue, source, overlay } = props();
    const pinned = repo && branch ? (shared(LINKS) ?? {})[`${repo}|${branch}`] : undefined;
    const go = (action) => (cx) => { closeOverlay(overlay); action(cx); };
    const items = [
      ...(repo && branch ? [["link", issue ? "Link a different ticket…" : "Link a ticket…", "mods/workspace-chrome/square-pen.svg", go(() => openLinkDialog(repo, branch))]] : []),
      ...(issue && source === "branch" ? [["not-this", "Not this ticket", "mods/workspace-chrome/x.svg", go(() => setLink(repo, branch, ""))]] : []),
      ...(pinned !== undefined ? [["detect", "Detect from branch", "mods/workspace-chrome/git-branch.svg", go(() => setLink(repo, branch, null))]] : []),
      ...(issue ? [["open", "Open in Linear", "mods/linear/ticket.svg", go(() => execFile("open", [issue.url]))]] : []),
      ["key", "Linear API key…", "mods/workspace-chrome/settings.svg", go(() => openKeyDialog())],
    ];
    return v_flex().id("linear-menu").w_full().p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .children(items.map(([id, label, icon, action], i) => v_flex()
        .when(id === "key" && i > 0, (e) => e.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`mi-${id}`).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => action(cx))
          .child(svg(icon).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(label)))));
  }

  dialog(t, title, subtitle, body) {
    return v_flex().w_full().p(20).gap(12).bg(t.popover).text_size(13).text_color(t.foreground)
      .when(Boolean(title), (e) => e.child(v_flex().gap(4).child(div().text_size(15).font_semibold().child(title))
        .when(Boolean(subtitle), (e) => e.child(div().text_color(t.muted).truncate().child(subtitle)))))
      .child(body);
  }

  render(cx) {
    const t = theme();
    if (this.view === "menu") return this.menu(t);
    if (this.view === "link") return this.dialog(t, "Link a Linear ticket", `To ${props().branch}`, v_flex().gap(8)
      .child(this.field("link", this.linkInput, t, (cx) => this.link(cx), "Link"))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error))));
    if (this.view === "key") return this.dialog(t, null, null, this.setup(t, () => closeOverlay(props().overlay)));
    this.refresh(cx);
    const issue = this.status === "issue" ? this.issue : null;
    const message = {
      loading: "Loading…",
      none: "No folder",
      "no-repo": "Not a git repository",
      "no-branch": "Not on a branch",
      "not-found": `No Linear ticket for ${this.branch}. Link one below.`,
      unlinked: `Unlinked from ${this.branch}. Link a ticket below, or go back to detecting it from the branch.`,
      error: this.error,
    }[this.status];
    // Only until a key works; changing it is in the Linear button's right-click menu.
    const setup = this.keyLoaded && this.status === "no-key";
    // With a ticket shown, linking lives in the Linear button's right-click menu.
    const footer = !setup && !issue && this.repo && this.branch && ["not-found", "unlinked", "error"].includes(this.status);
    return v_flex().id("linear").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/linear/ticket.svg").size(14).text_color(t.muted))
        .child(div().font_semibold().child("Linear"))
        .when(Boolean(issue), (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(this.source === "linked" ? "Linked" : "From branch"))))
      .when(setup, (e) => e.child(div().p(14).child(this.setup(t, null))))
      .when(!setup && Boolean(issue), (e) => e.child(this.ticket(issue, t)))
      .when(!setup && !issue, (e) => e.child(div().flex_1().p(14).text_color(t.dim).child(message ?? "")))
      .when(Boolean(footer), (e) => e.child(v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(this.field("link", this.linkInput, t, (cx) => this.link(cx), "Link"))
        .when(this.status === "unlinked", (e) => e.child(div().id("auto").text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { setLink(this.repo, this.branch, null); this.refresh(cx, true); cx.notify(); }).child("Detect from branch")))));
  }
}
