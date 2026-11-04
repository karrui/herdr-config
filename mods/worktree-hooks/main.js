// Worktree dialog: { space, action: "new" | "open" | "remove" | "close" } or
// { folder, machine } for a repo without a space; optional { branch, tab, argv }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, Checkbox } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, hc, appHome, shared, setShared, notify } from "herdr";
import { freshWorktree } from "./fresh-worktree.js";

// The repo's own worktree setup and teardown (.termic.yaml), on this computer only.
const HOOKS = () => `${appHome()}/agent/worktree`;
// "DEVX-642 Implement spec" -> "devx-642-implement-spec", for a branch name.
const hyphenate = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Checkouts go to <ROOT>/<repo>/<branch, slashes as dashes>.
const ROOT = (home) => `${home}/.herdr/worktrees`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaces().find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  // A folder that's gone (its worktree removed) can't run git: no repo either.
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on).catch(() => ({ ok: false }));
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on).catch(() => ({ ok: false }));
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.text = props()?.branch ?? "";
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    // A new worktree's space title; the branch follows it, hyphenated, until edited by hand.
    this.title = InputState.new({ placeholder: "Title (optional)" });
    this.title.on("change", (_e, cx) => { if (!this.branchEdited) this.input.set_value(hyphenate(this.title.value())); cx.notify(); });
    this.title.on("submit", (_e, cx) => this.go(cx));
    this.input.on("change", () => { this.branchEdited = this.input.value() !== hyphenate(this.title.value()); });
    const first = props()?.action === "new" && !props()?.branch ? this.title : this.input;
    // Remove and Close only confirm: Enter is theirs, not an input's.
    const confirming = ["remove", "close"].includes(props()?.action);
    if (!confirming) {
      first.focus();
      cx.timer.after(600, () => first.focus());
    }
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    // Remove: the worktree's branch goes too, unless unchecked; `lost` counts its
    // commits that aren't on any remote.
    this.branch = null;
    this.deleteBranch = true;
    this.lost = 0;
    this.handle = cx.focus_handle();
    if (confirming) this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const repo = await repoOf(this.folder, this.on);
        // Another space working in this worktree: closing this one leaves it be.
        const s = this.space(), within = (p) => p === repo?.top || Boolean(p?.startsWith(`${repo?.top}/`));
        this.sharedWith = repo?.linked && props()?.action === "close"
          ? spaces().find((o) => o.id !== s?.id && (o.machine ?? null) === (this.on ?? null) && within(place(o))) : null;
        if (repo && confirming) {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          this.unpushed = (await submodules(repo.top, this.on)).unpushed;
        }
        if (repo?.linked && props()?.action === "remove") {
          this.branch = (await git(repo.top, ["branch", "--show-current"], this.on)).out || null;
          if (this.branch) this.lost = Number((await git(repo.top, ["rev-list", "--count", "HEAD", "--not", "--remotes"], this.on)).out) || 0;
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        this.repo = repo;
        cx.notify();
        if (props().branch) await this.work(cx);
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Close works outside a repo too (its worktree already gone): it just closes the space.
  ready() {
    return this.repo || (this.repo === null && props()?.action === "close");
  }

  go(cx) {
    if (this.busy || !this.ready()) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.ready()) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    const action = props().action;
    try { this.error = action === "remove" ? await this.remove() : action === "close" ? await this.closeSpace() : await this.create(); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create() {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    const r = await freshWorktree(this.repo.top, branch, (b) => `${ROOT(this.userHome)}/${this.repo.name}/${slug(b)}`, this.on);
    if (r.error) return r.error;
    if (r.branch !== branch) notify({ title: `Made branch ${r.branch}`, body: `${branch} was taken.`, level: "info" });
    const path = r.dir, p = props();
    // A Setup pane runs the repo's setup first; the agent waits for it.
    const argv = this.on ? p.argv : [HOOKS(), "start", path, ...(p.argv ? ["--", ...p.argv] : [])];
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
    const name = this.title.value().trim();
    run("space.new", { folder: path, machine: this.on, tab: p.tab, argv, ...(name ? { name } : {}) });
    return "";
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path, machine: this.on });
  }

  async remove() {
    const s = this.space();
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    // git refuses a worktree with submodules unless forced, because their
    // history goes with it. The popup already showed what's at risk; only
    // risk that appeared since it opened gets one more warning.
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some((name) => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Enter again removes it anyway.";
    const force = this.dirty || mods.length > 0;
    const branch = this.deleteBranch ? this.branch ?? "" : "";
    // Here, the repo's teardown runs first, in the background, while the sidebar shows
    // the space struck through with its progress; the script then closes the space and
    // removes the worktree.
    if (!this.on) {
      setShared("worktree.teardown", { ...(shared("worktree.teardown") ?? {}), [s.id]: Date.now() });
      const r = await hc(["run", "--bg", "--cwd", this.repo.top, "--", "/bin/zsh", "-lic", 'exec "$0" remove "$1" "$2" "$3" "$4"',
        HOOKS(), this.repo.top, s.id, force ? "--force" : "", branch]);
      return r.code === 0 ? "" : r.stderr.trim() || "Couldn't start the teardown.";
    }
    // Terminals first: a shell sitting in the folder keeps it busy on Windows.
    run("space.close", { id: s.id, confirmed: true });
    const r = await git(this.repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), this.repo.top], this.on);
    if (!r.ok) return r.err || "git worktree remove failed.";
    const b = branch ? await git(this.repo.main, ["branch", "-D", branch], this.on) : { ok: true };
    return b.ok ? "" : b.err || `Couldn't delete branch ${branch}.`;
  }

  // Close on a Herdr worktree space (the menus' Close, a last tab's ×): the space stays,
  // struck through with the teardown's progress (space-folders), until the teardown is
  // done; then it closes, and the worktree goes too if that loses nothing uncommitted.
  async closeSpace() {
    const s = this.space();
    if (!s) return "";
    if (this.on || !this.repo?.linked || this.sharedWith) { run("space.close", { id: s.id, confirmed: true }); return ""; }
    setShared("worktree.teardown", { ...(shared("worktree.teardown") ?? {}), [s.id]: Date.now() });
    const r = await hc(["run", "--bg", "--cwd", this.repo.top, "--", "/bin/zsh", "-lic", 'exec "$0" closed "$1" "$2"', HOOKS(), this.repo.top, s.id]);
    return r.code === 0 ? "" : r.stderr.trim() || "Couldn't start the teardown.";
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "enter" && ["remove", "close"].includes(props()?.action)) return this.go(cx);
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 esc close"));
  }

  render(cx) {
    const t = theme();
    if (this.opening) return this.renderOpen(t);
    const remove = props()?.action === "remove", closing = props()?.action === "close";
    const s = this.space();
    const r = this.repo;
    const title = closing ? `Close ${s?.name ?? "this space"}?` : remove ? `Remove worktree ${s?.name ?? ""}?` : `New worktree${r ? ` of ${r.name}` : ""}`;
    const detail =
      r === undefined
        ? "…"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.${closing ? " The space closes with no teardown." : ""}`
          : closing && this.sharedWith
            ? `Its agents and terminals stop. ${this.sharedWith.name} is still working in ${tilde(r.top, this.userHome)}, so the worktree stays.`
          : closing
            ? `Its agents and terminals stop. This repo's teardown runs first, then the space closes${this.dirty ? "." : ` and ${tilde(r.top, this.userHome)} is deleted. The branch stays.`}`
          : remove
            ? !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : `${this.on ? "" : "Runs this repo's teardown, then "}${this.on ? "Closes" : "closes"} the space and deletes ${tilde(r.top, this.userHome)}.`
            : `A new space on a checkout in ${tilde(ROOT(this.userHome), this.userHome)}/${r.name}/. It starts on a new branch from origin's latest default branch; a taken name gets -2.`;
    const blocked = closing ? r === undefined : !r || (remove && !r.linked);
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.muted).child(detail))
      .when(remove && this.dirty, (el) => el.child(div().text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
      .when(closing && this.dirty && !this.sharedWith, (el) => el.child(div().text_color(t.ansi3).child(`It has uncommitted changes, so ${tilde(r.top, this.userHome)} is kept.`)))
      .when(remove && Boolean(r?.linked && this.branch), (el) => el.child(this.checkbox(t)))
      .when(remove && this.deleteBranch && this.lost > 0, (el) => el.child(div().text_color(t.blocked)
        .child(`${this.branch} has ${this.lost} commit${this.lost === 1 ? " that isn't" : "s that aren't"} pushed anywhere: ${this.lost === 1 ? "it" : "they"} will be lost.`)))
      .when(remove && this.unpushed.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
      .when(!remove && !closing && !blocked, (el) =>
        el.child(
          Input.new(this.title)
            .h(32)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(t.input)
            .bg(t.background)
            .text_color(t.foreground),
        ).child(
          Input.new(this.input)
            .h(32)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(this.inputFocused ? t.accent : t.input)
            .bg(t.background)
            .text_color(t.foreground),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .items_center()
          .when(this.busy, (el) => el.child(div().flex_1().text_size(11.5).text_color(t.dim).child("Working…")))
          .child(this.button("cancel", blocked ? "Close" : "Cancel", "esc", t.raised, t.foreground, () => this.close()))
          .when(!blocked, (el) => el.child(closing
            ? this.button("close-space", "Close", "↵", t.blocked, "#ffffff", (_e, cx) => this.go(cx))
            : remove
            ? this.button("remove", "Remove", "↵", t.blocked, "#ffffff", (_e, cx) => this.go(cx))
            : this.button("create", "Create", "↵", t.solid, t.solid_foreground, (_e, cx) => this.go(cx)))),
      );
  }

  // "Delete branch <name>", checked unless the user unchecks it. GitHub's copy stays.
  checkbox(t) {
    const on = this.deleteBranch;
    return Checkbox.new("delete-branch").checked(on).on_change((v, cx) => { this.deleteBranch = v; cx.notify(); })
      .child(h_flex().gap(8).items_center().cursor_pointer().text_color(t.foreground)
        .child(h_flex().size(16).flex_none().rounded(4).border(1).items_center().justify_center()
          .border_color(on ? t.solid : t.input).bg(on ? t.solid : t.background)
          .when(on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(12).text_color(t.solid_foreground))))
        .child(div().min_w(0).truncate().child(`Delete branch ${this.branch}`)));
  }

  // A dialog button with its key beside the label; dimmed while working.
  button(id, label, key, bg, fg, action) {
    const t = theme();
    return h_flex().id(id).h(30).px(12).gap(8).flex_none().items_center().rounded(7).bg(bg).text_color(fg)
      .text_size(12.5).font_medium()
      .when(this.busy, (el) => el.opacity(0.5))
      .when(!this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .child(label).child(div().text_size(11).opacity(0.7).child(key));
  }
}
