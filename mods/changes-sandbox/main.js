import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { spaces, panes, focused, agents, exec as execFile, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// What the panel compares. null is a separator in the menu.
const MODES = [["turn", "Last Turn"], null, ["uncommitted", "Uncommitted"], ["unstaged", "Unstaged"], ["staged", "Staged"], null, ["commit", "Committed"], ["branch", "Branch"]];
const LABEL = Object.fromEntries(MODES.filter(Boolean));
const NONE = { turn: "No changes in the last turn", uncommitted: "No uncommitted changes", unstaged: "No unstaged changes", staged: "No staged changes", commit: "No changes in this commit", branch: "No changes on this branch" };

// The whole working tree, untracked files included, as a tree object, through a
// throwaway index so the real one is never touched. Starts from a copy of the real
// index so unchanged files aren't hashed again.
const SNAPSHOT = 'i=$(mktemp) && trap \'rm -f "$i"\' EXIT && { cp "$(git rev-parse --git-path index)" "$i" 2>/dev/null || :; } && GIT_INDEX_FILE="$i" git add -A >/dev/null && GIT_INDEX_FILE="$i" git write-tree';
async function snapshot(root, on) {
  const r = await execFile("/bin/sh", ["-c", SNAPSHOT], { cwd: root, on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Couldn't snapshot the working tree");
  return r.stdout.trim();
}

// The branch to compare against: origin's default branch, else the usual names.
async function baseBranch(git) {
  const head = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const names = [head.code === 0 ? head.stdout.trim() : null, "origin/main", "origin/master", "main", "master"].filter(Boolean);
  for (const name of names) if ((await git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).code === 0) return name;
  return null;
}

// The mode last picked, except Committed: which commit depends on the repo.
function savedMode() {
  try { const m = localStorage.getItem("mode"); return LABEL[m] && m !== "commit" ? m : "uncommitted"; } catch { return "uncommitted"; }
}

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.mode = savedMode(); this.commitPick = null; this.menu = null; this.commits = [];
    // Last Turn: each agent's repo as it was when the agent last started working.
    this.turns = {}; this.statuses = {};
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // ponytail: polled, so a turn's first second of edits can land before its snapshot;
    // turns live in memory, so one started before this panel first showed has none.
    this.trackTurns(cx);
    cx.timer.every(1000, (cx) => this.trackTurns(cx));
  }

  trackTurns(cx) {
    for (const a of agents()) {
      const was = this.statuses[a.address];
      this.statuses[a.address] = a.status;
      if (a.status !== "working" || was === undefined || was === "working") continue;
      const cwd = panes().find((p) => p.pane === a.pane)?.cwd, on = spaces().find((s) => s.id === a.space)?.machine ?? null;
      if (!cwd) continue;
      cx.spawn(async (cx) => {
        try {
          const top = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (top.code !== 0) return;
          const root = top.stdout.trim();
          this.turns[a.address] = { root, on, tree: await snapshot(root, on), at: Date.now() };
          if (this.mode === "turn" && this.root === root) this.refresh(cx);
        } catch {}
      });
    }
  }

  // The agent whose last turn to show: the focused one, else the latest in this repo.
  turn() {
    const here = (t) => t && t.root === this.root && t.on === this.on;
    const mine = this.turns[focused()?.terminal];
    if (here(mine)) return mine;
    return Object.values(this.turns).filter(here).sort((a, b) => b.at - a.at)[0] ?? null;
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  // What `git diff` compares in this mode, and whether untracked files count.
  async range(git, root, on, hasHead) {
    this.detail = null;
    switch (this.mode) {
      case "uncommitted": return { args: [hasHead ? "HEAD" : EMPTY_TREE], untracked: true };
      case "unstaged": return { args: [], untracked: true };
      case "staged": return { args: ["--cached"], untracked: false };
      case "branch": {
        const base = await baseBranch(git);
        if (!base) throw new Error("No base branch found (origin/HEAD, main or master)");
        const mb = hasHead ? await git(["merge-base", base, "HEAD"]) : null;
        if (!mb || mb.code !== 0) throw new Error(`This branch has nothing in common with ${base}`);
        const branch = (await git(["branch", "--show-current"])).stdout.trim() || "HEAD";
        this.detail = `${branch}  →  ${base}`;
        return { args: [mb.stdout.trim()], untracked: true };
      }
      case "commit": {
        const c = this.commitPick;
        if (!c) throw new Error("Pick a commit from the menu");
        const parent = await git(["rev-parse", "--verify", "--quiet", `${c.sha}^`]);
        this.detail = `${c.short}  ${c.subject}`;
        return { args: [parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE, c.sha], untracked: false };
      }
      case "turn": {
        const t = this.turn();
        if (!t) throw new Error("No turn yet: one is recorded when an agent here starts working");
        this.detail = `Since ${new Date(t.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
        return { args: [t.tree, await snapshot(root, on)], untracked: false };
      }
    }
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key(), mode = this.mode;
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
      if (this.mode === "commit") { this.mode = "uncommitted"; this.commitPick = null; }
    }
    if (!cwd) return;
    this.loading = true;
    const started = this.mode;
    cx.spawn(async (cx) => {
      const current = () => key() === context && this.mode === started;
      try {
        const top = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (!current()) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.detail = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => execFile("git", [...READ, ...args], { cwd: root, on });
        this.root = root; this.on = on;
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const { args, untracked } = await this.range(git, root, on, head.code === 0);
        // --numstat reads contents, so a file only touched (a stat change) isn't listed;
        // --name-status gives the letter for the ones that are.
        const [num, names, others] = await Promise.all([
          git(["diff", ...args, "--numstat", "-z", "--no-renames"]),
          git(["diff", ...args, "--name-status", "-z", "--no-renames"]),
          untracked ? git(["ls-files", "--others", "--exclude-standard", "-z"]) : null,
        ]);
        for (const r of [num, names, others]) if (r && r.code !== 0) throw new Error(r.stderr);
        const letters = {}, parts = names.stdout.split("\0");
        for (let i = 0; i + 1 < parts.length; i += 2) letters[parts[i + 1]] = parts[i][0];
        const files = [];
        for (const entry of num.stdout.split("\0")) {
          const [a, d, ...rest] = entry.split("\t");
          if (!rest.length) continue;
          const path = rest.join("\t"), letter = letters[path] ?? "M";
          files.push({ path, status: letter === "T" ? "M" : letter, fresh: false, add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" });
        }
        for (const path of (others?.stdout ?? "").split("\0").filter(Boolean)) files.push({ path, status: "A", fresh: true, add: 0, del: 0 });
        files.sort((a, b) => a.path.localeCompare(b.path));
        if (!current()) return;
        this.hasHead = head.code === 0; this.args = args; this.limited = files.length > 1000; this.files = files.slice(0, 1000); this.error = null;
        this.watch(root, cx);
        if (this.open && !this.files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && this.files.length) this.open = this.files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (current()) { this.files = []; this.open = null; this.setLines([]); this.error = String(e.message ?? e); } }
      finally {
        this.loading = false;
        // The mode changed while this ran: show the new one.
        if (this.mode !== started) this.refresh(cx);
        cx.notify();
      }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await execFile("git", [...READ, "diff", ...this.args, "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  setMode(mode, pick, cx) {
    this.menu = null;
    if (mode === this.mode && pick?.sha === this.commitPick?.sha) return cx.notify();
    this.mode = mode; this.commitPick = pick ?? null;
    if (mode !== "commit") try { localStorage.setItem("mode", mode); } catch {}
    this.files = []; this.open = null; this.closed = false; this.detail = null; this.error = null; this.setLines([]);
    this.refresh(cx);
    cx.notify();
  }

  // Committed's submenu: this branch's commits, else the latest ones.
  openCommits(cx) {
    this.menu = "commits"; this.commits = null;
    const root = this.root, on = this.on;
    if (!root) { this.commits = []; return cx.notify(); }
    cx.spawn(async (cx) => {
      const git = (args) => execFile("git", [...READ, ...args], { cwd: root, on });
      const log = (range) => git(["log", "-n", "30", "--format=%H%x09%h%x09%s", ...range]);
      const base = await baseBranch(git);
      const mb = base ? await git(["merge-base", base, "HEAD"]) : null;
      let r = mb?.code === 0 ? await log([`${mb.stdout.trim()}..HEAD`]) : null;
      if (!r || r.code !== 0 || !r.stdout.trim()) r = await log(["HEAD"]);
      this.commits = r.code === 0 ? r.stdout.trim().split("\n").filter(Boolean).map((l) => { const [sha, short, ...s] = l.split("\t"); return { sha, short, subject: s.join("\t") }; }) : [];
      cx.notify();
    });
    cx.notify();
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    // In Staged, commit what's staged; everywhere else, everything.
    const steps = this.mode === "staged" ? [["commit", "-m", message]] : [["add", "-A"], ["commit", "-m", message]];
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          const r = await execFile("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  menuItem(id, label, t, { checked, chevron, back, dim, hint } = {}, action) {
    return h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .text_color(dim ? t.muted : t.foreground).on_click((_e, cx) => action(cx))
      .when(Boolean(back), (e) => e.child(svg("mods/workspace-chrome/chevron-left.svg").size(12).flex_none().text_color(t.muted)))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(hint), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)))
      .when(Boolean(checked), (e) => e.child(svg("mods/workspace-chrome/check.svg").size(13).flex_none().text_color(t.foreground)))
      .when(Boolean(chevron), (e) => e.child(svg("mods/workspace-chrome/chevron-right.svg").size(12).flex_none().text_color(t.muted)));
  }

  renderMenu(t) {
    const sep = (i) => div().mx(6).my(4).h(1).flex_none().bg(t.border);
    const note = (text) => div().px(8).h(28).flex().flex_none().items_center().text_color(t.dim).child(text);
    const body = this.menu === "commits"
      ? [this.menuItem("commits-back", "Committed", t, { back: true, dim: true }, (cx) => { this.menu = "modes"; cx.notify(); }), sep("c"),
         ...(this.commits === null ? [note("Loading…")] : !this.commits.length ? [note("No commits")]
           // A fixed height: a scroll area that sizes to its content collapses in an absolute menu.
           : [v_flex().id("commit-list").h(Math.min(this.commits.length, 10) * 28).overflow_y_scrollbar().children(
               this.commits.map((c) => this.menuItem(`commit-${c.sha}`, c.subject, t, { hint: c.short, checked: this.mode === "commit" && this.commitPick?.sha === c.sha },
                 (cx) => this.setMode("commit", c, cx))))])]
      : MODES.map((m, i) => m === null ? sep(i) : this.menuItem(`mode-${m[0]}`, m[1], t, { checked: this.mode === m[0], chevron: m[0] === "commit" },
          (cx) => m[0] === "commit" ? this.openCommits(cx) : this.setMode(m[0], null, cx)));
    return v_flex().id("changes-menu").absolute().top(38).left(10).w(this.menu === "commits" ? 300 : 200)
      .p(4).rounded(10).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(12.8)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      .children(body);
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const label = this.mode === "commit" && this.commitPick ? this.commitPick.short : LABEL[this.mode];
    return v_flex().id("changes").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.menu) { this.menu = null; cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().id("changes-mode").h(26).pl(10).pr(7).gap(5).items_center().rounded(13).cursor_pointer().bg(this.menu ? t.selected : t.raised).hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.menu = this.menu ? null : "modes"; this.handle.focus(); cx.notify(); })
          .child(div().font_semibold().text_size(12.5).child(label))
          .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).text_color(t.muted)))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .when(Boolean(this.detail), (e) => e.child(div().h(26).flex_none().px(14).flex().items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted).child(div().min_w(0).truncate().child(this.detail))))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? NONE[this.mode] : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : this.mode === "staged" ? "Commit staged" : "Commit")))
      .when(Boolean(this.menu), (e) => e.child(this.renderMenu(t)));
  }
}
