// Modified for herdr-config: support the shared sidebar and omit the AI review button.
// A pulls.review review drawn in a pane, beside the agent that wrote the change: groups (the AI
// analysis, else rule-based), each group's files and their diffs, reviewed marks, one commit at
// a time. Opened by the pulls-review mod in "herdr" mode with props `{ root, page, n }`;
// later opens in the same tab arrive through shared(PANE). Everything comes from the jin.review daemon.

import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, h_resizable, resizable_panel, Scrollbar, v_virtual_list, VirtualListScrollHandle, TextView, Switch, InputState, Input } from "gpui-base";
import { exec, focused, layout, panes, props, settings, setShared, shared, spaces, theme, watchFolder, window as appWindow } from "herdr";
import { request, review } from "./daemon.js";
import { buildItems, codeInset, contentWidth, FILE, fileRows, groupFiles, noteWidth, pageLabel, ROW } from "./rows.js";

const PANE = "review";
function findBlock(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const match = findBlock(child, id); if (match) return match; }
  return null;
}
// How long a read may take before the pane says it didn't answer and offers Retry; its answer still counts if it comes.
const LOAD_TIMEOUT = 30000;
// How long a sideways scroll's bars stay after it stops (ms).
const BARS_LINGER = 1000;
// Preferences every review pane shares: a pane's localStorage is its own, so a new pane would start from the defaults.
const PREFS = `${PANE}.prefs`;
const pref = (key) => shared(PREFS)?.[key];
const setPref = (key, value) => setShared(PREFS, { ...shared(PREFS), [key]: value });
const MONO = "JetBrains Mono";
// The app's category icons (Lucide here, for one icon set across the layout; the app's are Phosphor duotone, in its own shapes) and hues (Tailwind's 300 on dark, 800 on light), by category.
const CATEGORY = {
  ui: ["drafting-compass", "#f9a8d4", "#9d174d"], api: ["plug-zap", "#93c5fd", "#1e40af"], core: ["code", "#c4b5fd", "#5b21b6"],
  data: ["database", "#fcd34d", "#92400e"], cli: ["terminal", "#bef264", "#3f6212"], security: ["shield-check", "#fca5a5", "#991b1b"],
  tests: ["flask-conical", "#86efac", "#166534"], docs: ["book-open", "#7dd3fc", "#075985"], examples: ["circle-play", "#67e8f9", "#155e75"],
  deps: ["package", "#fdba74", "#9a3412"], build: ["hammer", "#fde047", "#854d0e"], scripts: ["wrench", "#6ee7b7", "#065f46"],
  config: ["sliders-horizontal", "#5eead4", "#115e59"], i18n: ["languages", "#a5b4fc", "#3730a3"], assets: ["image", "#f0abfc", "#86198f"],
  other: ["circle-ellipsis", "#d4d4d4", "#262626"],
};
// Herdr scales what a script sets by its zoom, but reports sizes and positions scaled already: they come back divided by it,
// and a path, painted unscaled, goes out multiplied by it.
const zoom = () => Number(settings()?.zoom) || 1;
// A light theme takes the darker hues, as the app's `dark:` variants switch them.
const isLight = (hex) => { const n = parseInt(String(hex).slice(1, 7), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.5; };
// As CSS's saturate(0), which the app puts on a group's icon until it's shown or hovered: a hue's luminance, as grey.
const grey = (hex) => { const n = parseInt(hex.slice(1, 7), 16), y = Math.round(0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)); return `#${y.toString(16).padStart(2, "0").repeat(3)}`; };

// The app's hover and active tones (bg-hover, bg-active): translucent grey, so a hovered button reads over a hovered row.
// Every hover in the pane takes HOVER; what's selected, open or in view takes ACTIVE.
const HOVER = "#99999915", ACTIVE = "#99999920";
// @antfu/design's opacities: op-fade for what waits for a hover, op-disabled; and its segment track and raised pill.
const FADE = 0.65, DISABLED = 0.3;
const sunken = (t) => isLight(t.background) ? "#0000000a" : "#ffffff0f", raised = (t) => isLight(t.background) ? "#ffffffa6" : "#00000099";

// Models the settings list before the search must narrow them.
const LISTED = 200;
// As the app's LOCALES (core/locales.ts): the languages an analysis can write in, by their own names.
const LOCALES = [["en", "English"], ["zh-CN", "简体中文"], ["zh-TW", "繁體中文"], ["ja", "日本語"], ["ko", "한국어"], ["es", "Español"], ["fr", "Français"],
  ["de", "Deutsch"], ["pt-BR", "Português (Brasil)"], ["ru", "Русский"], ["it", "Italiano"], ["id", "Bahasa Indonesia"]];
// Responsive widths, the app's: the sidebar from WIDE (its `lg`; narrower, the groups are tabs over the diff), split from
// SPLIT_MIN of diff (its MIN_SPLIT_WIDTH_PX; narrower, unified, the choice kept).
const WIDE = 1024, SPLIT_MIN = 640;
// As the app's group aside beside the diffs at `lg`: a fifth of the row, at least 280, at most half.
const ASIDE_MIN = 280, ASIDE_MAX_RATIO = 0.5;
// As the app's FileStatus: a letter in its status's color (success, error, warning, blue at 500).
const FILE_STATUS = { added: ["A", "#22c55e"], removed: ["D", "#ef4444"], modified: ["M", "#f59e0b"], renamed: ["R", "#3b82f6"], copied: ["C", "#3b82f6"] };
// As @antfu/design's file and folder icons (catppuccin, in cat/): the first matching rule wins, else the plain file.
const FILE_ICONS = [[/\.vue$/, "vue"], [/\.tsx$/, "typescript-react"], [/\.jsx$/, "javascript-react"], [/\.d\.[cm]?ts$/, "typescript-def"],
  [/\.[cm]?ts$/, "typescript"], [/\.[cm]?js$/, "javascript"], [/\.json5?$/, "json"], [/\.ya?ml$/, "yaml"], [/\.toml$/, "toml"], [/\.md$/, "markdown"],
  [/\.html?$/, "html"], [/\.(?:css|postcss)$/, "css"], [/\.s[ac]ss$/, "sass"], [/\.svg$/, "svg"], [/\.(?:png|jpe?g|gif|webp|avif|ico)$/, "image"],
  [/\.(?:woff2?|ttf|otf|eot)$/, "font"], [/package\.json$/, "npm"], [/\.(?:test|spec)\.[cm]?[jt]sx?$/, "typescript-test"]];
const fileIcon = (path) => FILE_ICONS.find(([match]) => match.test(path))?.[1] ?? "file";
const FOLDER_ICONS = { src: "folder-src", dist: "folder-dist", node_modules: "folder-node", test: "folder-tests", tests: "folder-tests", public: "folder-public",
  components: "folder-components", utils: "folder-utils", config: "folder-config", assets: "folder-images", scripts: "folder-scripts", styles: "folder-styles", lib: "folder-lib" };
// A chain of folders (`packages/cli/src`) is named by its last. Always closed, as the app's FileTree draws them.
const folderIcon = (name) => FOLDER_ICONS[name.split("/").pop().toLowerCase()] ?? "folder";

// Syntax kinds in the theme's own colors, as the shipped files mod colors code.
function colors(t) {
  const kinds = { foreground: t.foreground, keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6 };
  return Object.fromEntries(Object.entries(kinds).filter(([, color]) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color ?? "")));
}

// As the app's describeProgress, but the file's name only: the agent's paths run long, often through its own scratch folder.
function progressText(progress) {
  const n = progress?.paths?.length ?? 0;
  if (progress?.kind === "reading") return `Reading ${n} ${n === 1 ? "file" : "files"}: ${progress.paths[0]?.split("/").pop() ?? ""}${n > 1 ? ", …" : ""}`;
  if (progress?.kind === "organizing") return "Organizing groups…";
  if (progress?.kind === "thinking") return `Thinking… (step ${progress.step})`;
  return "Starting…";
}
// Lucide's icons (lucide/), the layout's one set, and the catppuccin file icons (cat/), as the app draws them.
const LU = `mods/${PANE}/lucide`, CAT = `mods/${PANE}/cat`;

// In the browser, as mods/pulls-review opens one.
function openUrl(url) {
  const platform = appWindow()?.platform;
  const [command, args] = platform === "macos" ? ["open", [url]]
    : platform === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  exec(command, args).catch(() => {});
}

// Worth a read? Of Git's own files only HEAD and refs, and nothing Git ignores: macOS reports those too.
// `git check-ignore` exits 0 when some are ignored, listing them, 1 when none are, 128 when it can't judge.
async function touchesDiff(root, paths) {
  if (paths.some(p => /\/\.git\/(HEAD|refs\/)/.test(p))) return true;
  const files = paths.filter(p => !/\/\.git(\/|$)/.test(p));
  if (!files.length) return false;
  const r = await exec("git", ["--no-optional-locks", "check-ignore", "--", ...files], { cwd: root }).catch(() => null);
  return r?.code !== 0 || r.stdout.trim().split("\n").length < files.length;
}

// Spaces that end an element are drawn into a following ligature (` =>` shows as `)⇒`): each run's
// trailing spaces lead the next run instead, where they hold their width.
function spans(tokens) {
  const out = [];
  let carry = "";
  for (const [text, color] of tokens) {
    const t = carry + text.replaceAll("\t", "    "), body = t.trimEnd();
    carry = t.slice(body.length);
    if (body) out.push([body, color]);
  }
  return out;
}

export default class ReviewPane extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.inSidebar = p.sidebar === true;
    const selected = this.inSidebar ? shared("review.sidebar")?.[focused()?.tab] : null;
    this.tab = this.inSidebar ? focused()?.tab : localStorage.getItem("tab") ?? focused()?.tab;
    localStorage.setItem("tab", this.tab ?? "");
    this.root = this.inSidebar ? selected?.root : localStorage.getItem("root") ?? p.root;
    this.page = this.inSidebar ? selected?.page : localStorage.getItem("page") ?? p.page;
    this.base = this.inSidebar ? selected?.base ?? this.page : localStorage.getItem("base") ?? this.page;
    this.handled = Number(this.inSidebar ? selected?.n ?? 0 : localStorage.getItem("handled") ?? p.n ?? 0);
    this.split = pref("split") === true;
    // The sidebar's file list, a tree or a list, as the app's own toggle; a tree by default, as there.
    this.fileList = pref("fileList") === "list" ? "list" : "tree";
    // Groups as tabs or, wide enough, a sidebar, as the app's DiffGroupNavToggle; tabs by default, as there.
    this.groupNav = pref("groupNav") === "sidebar" ? "sidebar" : "tabs";
    // Starting an analysis on open is this pane's own choice, off by default: the app never starts a paid, slow AI run
    // by itself. The agent, model and language are the daemon's shared settings.
    this.autoAnalyze = pref("autoAnalyze") === true;
    // The one popup open over the diff, if any: "settings", "status" or "fold".
    this.popup = null; this.closedPopup = null; this.popupClosedAt = 0;
    this.agents = null; this.shared = null; this.settingsError = null;
    this.height = 600; this.headerHidden = false; this.scrolledDownBy = 0; this.baseCommits = null;
    // The model field searches the agent's catalog; Enter picks the model it names exactly, else the text as typed.
    this.modelInput = InputState.new({ placeholder: "Search or type a model" });
    // ↑ ↓ move a highlight through the listed models; Enter on one picks it.
    this.modelIndex = -1;
    this.modelInput.on("change", (_e, cx) => { this.modelIndex = -1; cx.notify(); });
    this.modelInput.on("submit", (_e, cx) => {
      const typed = this.modelInput.value().trim(), { catalog, shown } = this.models();
      const lit = shown[this.modelIndex];
      if (!this.shared || (!typed && !lit)) return;
      const hit = lit ?? catalog.find(m => [m.id, m.name].some(x => x.toLowerCase() === typed.toLowerCase()));
      this.modelInput.set_value(""); this.modelIndex = -1; this.settingsPage = null;
      this.saveLlm({ agentModel: hit?.id ?? typed }, cx);
    });
    this.review = null; this.error = null; this.version = 0; this.width = 900; this.view = 600; this.listHeight = 600; this.frames = 0; this.sideWidth = [0, 0, 0]; this.shift = [0, 0, 0];
    this.startingUntil = 0; this.loading = null; this.loadId = 0;
    this.marks = 0; this.marking = 0;
    this.collapsed = new Set(); this.full = new Map(); this.seen = new Set(); this.auto = new Set(); this.asked = new Set(); this.folded = new Set();
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.barsOn = false; this.barsRun = 0;
    this.load(cx);
    // While a run goes the pane follows it; otherwise the folder watch and a slow timer catch new diffs.
    cx.timer.every(1500, (cx) => { if (this.analyzing()) this.poll(cx); });
    // Unseen, the slow timer and the watch only note a read is due; it follows within a second of the pane being seen again.
    // Hidden panes keep their timers, and a run's poll goes on: tabs show its state.
    cx.timer.every(15000, (cx) => this.refresh(cx));
    cx.timer.every(1000, (cx) => { if (this.dirty && this.onScreen()) this.load(cx); });
    // Scrolling redraws only the list. What the rest shows of where it is - the aside's group, the files and groups in view,
    // as the app's scroll spy marks them - is checked here and redrawn when it moved.
    cx.timer.every(150, (cx) => { const spied = this.spied(); if (spied !== this.lastSpied) { this.lastSpied = spied; cx.notify(); } });
  }

  remember() {
    for (const [key, value] of Object.entries({ root: this.root, page: this.page, base: this.base, handled: String(this.handled) })) localStorage.setItem(key, value);
  }

  open(page, cx) {
    if (page === this.page) return;
    // The old page stays on screen, dimmed and inert, until the new one's read replaces it: apply() then resets what belonged to it.
    this.page = page; this.switching = Boolean(this.review); this.error = null; this.analyzeError = null; this.startingUntil = 0; this.asked.clear(); this.headerHidden = false;
    this.wasRunning = false; this.news = null;
    this.remember(); this.version++;
    this.load(cx);
  }

  // No review shown, or none yet: what belonged to the last one goes with it.
  forget() { this.review = null; this.switching = false; this.groupKey = null; this.current = null; this.full.clear(); }

  watch(cx) {
    const root = this.root;
    if (this.watching === root) return;
    this.watching = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watching === root) {
          const paths = await watchFolder(root);
          if (this.watching === root && await touchesDiff(root, paths)) this.refresh(cx);
          // At most one change read a second: what changes meanwhile comes in the next batch.
          await new Promise(resolve => cx.timer.after(1000, resolve));
        }
      } catch { this.watching = null; }
    });
  }

  // The window active and this pane's tab the one shown.
  onScreen() {
    if (appWindow()?.active === false) return false;
    if (this.inSidebar) {
      const tree = layout();
      return focused()?.tab === this.tab && !findBlock(tree, "panel")?.hidden && findBlock(tree, "panel-body")?.active === "review";
    }
    return spaces().some(s => s.active && s.tabs.some(c => c.id === this.tab && c.active));
  }

  refresh(cx) { if (this.onScreen()) this.load(cx); else this.dirty = true; }

  // Rows come only for the group shown (a large diff's run to megabytes), and none while polling a run:
  // apply() keeps the rows of files whose sha didn't change. With no group yet, the first group's rows come with the read;
  // a daemon too old for `firstRows` ignores it, and the group's rows are asked for once it shows.
  // Only the latest read counts: a read of the page being read waits for it (a burst of changes can't restart it forever),
  // a read of another starts at once and the old one's answer is dropped.
  load(cx, poll = false) {
    if (!this.root || !this.page) return;
    if (this.loading?.root === this.root && this.loading.page === this.page) { this.again = true; return; }
    // Switching, the group shown is the old page's: the new page's first group comes with the read instead.
    const { root, page } = this, t = theme(), group = this.switching ? null : this.group(), marks = this.marks, id = ++this.loadId;
    this.loading = { root, page }; this.again = false; this.dirty = false;
    // Rows only for the group's files that have none: apply() keeps the rest, and each asked-for file is highlighted anew.
    const rows = poll || !group ? [] : groupFiles(group).filter(path => this.review.files.some(f => f.path === path && !f.hunks));
    for (const file of this.review?.files ?? []) if (rows.includes(file.path)) this.asked.add(file.sha);
    this.colorsKey = JSON.stringify(colors(t));
    cx.timer.after(LOAD_TIMEOUT, (cx) => {
      if (id !== this.loadId || !this.loading) return;
      this.loading = null; this.error = `jin.review didn't answer in ${LOAD_TIMEOUT / 1000} s`;
      // Not under the new page's title.
      if (this.switching) this.forget();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const r = await review(root, "/api/review", { page, colors: colors(t), rows, firstRows: !group });
        if (id !== this.loadId) return;
        // Read before a reviewed mark landed, it would undo the mark on screen: the mark's own read follows.
        if (this.marking || marks !== this.marks) return;
        this.apply(r);
        this.error = null;
        this.watch(cx);
        this.loadBase(cx);
        // Opening a page with no analysis starts one, once per head. An outdated one waits for Re-analyze:
        // every commit on the branch would otherwise start another run.
        const a = r.analysis, once = `${page}@${r.head?.sha}`;
        if (this.autoAnalyze && a.agent && !a.error && a.state === "none" && !this.auto.has(once)) {
          this.auto.add(once);
          this.analyze(cx, false);
        }
      } catch (e) { if (id === this.loadId) { this.error = e?.message ?? String(e); if (this.switching) this.forget(); } }
      finally {
        if (id === this.loadId) {
          this.loading = null;
          this.report();
          cx.notify();
          if (this.again) this.load(cx);
        }
      }
    });
  }

  // A run's state, without reading the diff: running, it updates in place; ended, or failed anew, the diff is read; not
  // started yet, nothing. A daemon without the route, or any failure, reads the diff as before. One call at a time.
  poll(cx) {
    if (this.polling) return;
    const { root, page } = this;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const s = await review(root, "/api/review/status", { page });
        const a = this.review?.analysis;
        if (root !== this.root || page !== this.page || !a || this.switching) return;
        if (s.running) {
          this.review.analysis = { ...a, state: "running", progress: s.progress }; this.startingUntil = 0;
          this.report(); cx.notify();
        } else if (a.state === "running" || (s.error && s.error !== a.error)) this.load(cx, true);
      } catch { if (root === this.root && page === this.page) this.load(cx, true); }
      finally { this.polling = false; }
    });
  }

  apply(r) {
    // Noisy and reviewed files start collapsed, the first time each version of them shows.
    for (const file of r.files) {
      if (this.seen.has(file.sha)) continue;
      this.seen.add(file.sha);
      if (file.noisy || file.reviewed) this.collapsed.add(file.path);
    }
    const old = new Map(this.review?.files.map(file => [file.path, file]));
    for (const file of r.files) if (!file.hunks && old.get(file.path)?.sha === file.sha) file.hunks = old.get(file.path).hunks;
    // A read that says what the one shown does changes nothing: the list isn't rebuilt, and its files stay the ones marks change.
    const said = (x) => JSON.stringify([x.key, x.title, x.base, x.head, x.commits, x.source, x.groups, x.analysis,
      x.files.map(f => [f.path, f.sha, f.reviewed, f.changed, Boolean(f.hunks)])]);
    if (this.review && !this.switching && said(r) === said(this.review)) return;
    for (const path of this.full.keys()) if (old.get(path)?.sha !== r.files.find(file => file.path === path)?.sha) this.full.delete(path);
    const switched = this.switching;
    if (switched) { this.forget(); this.scrolledDownBy = 0; this.settling = null; }
    this.review = r;
    if (r.analysis.state === "running") this.startingUntil = 0;
    // The diff's commits, for stepping through them while one is shown on its own (its page lists only itself).
    if (this.page === this.base) this.baseCommits = r.commits;
    if (!r.groups.some(g => g.key === this.groupKey)) this.groupKey = r.groups[0]?.key ?? null;
    this.version++;
    // The old page's list was kept on screen, scrolled: the new one starts at its top.
    if (switched) this.scroll.scroll_to_item(0);
  }

  // Reopened on one commit's page, which lists only itself: the diff's commits come from its base, read once without rows.
  // A failed read leaves the commit alone in the bar's list.
  loadBase(cx) {
    const { root, base } = this, key = `${root}\n${base}`;
    if (this.page === base || this.baseCommits || this.baseAsked === key) return;
    this.baseAsked = key;
    cx.spawn(async (cx) => {
      const r = await review(root, "/api/review", { page: base, colors: colors(theme()), rows: [] }).catch(() => null);
      if (r && root === this.root && base === this.base && !this.baseCommits) { this.baseCommits = r.commits; cx.notify(); }
    });
  }

  analyze(cx, force) {
    const { root, page } = this;
    // shortcut: 10 s is a guess at the slowest start, and a start that fails says nothing; replace it once the worktree server answers when it has started.
    this.startingUntil = Date.now() + 10000; this.analyzeError = null;
    cx.timer.after(10000, (cx) => { this.report(); cx.notify(); });
    cx.notify();
    cx.spawn(async (cx) => {
      try { await review(root, "/api/review/analyze", { page, force }); }
      catch (e) { this.startingUntil = 0; this.analyzeError = e?.message ?? String(e); }
      cx.notify();
      this.load(cx);
    });
  }

  // A run going, as the app's from the click: the daemon answers before the worktree server has started it, and a read until then finds none.
  analyzing() { return (!this.switching && this.review?.analysis.state === "running") || Date.now() < this.startingUntil; }

  // What its tab and pane header show (t3's name.js), as the word an agent would report: a run going, then how it ended
  // until the tab is looked at. In the pane, the button keeps a failure.
  // shortcut: a pane starts only when shown, so the Review bar drops a run's word from before a restart (its main.js); with no bar in the layout, that word stays until its tab is shown.
  report() {
    if (this.inSidebar) return;
    const a = this.switching ? null : this.review?.analysis, real = a?.state === "running", mine = panes().filter(p => p.mod === PANE);
    if (!mine.some(p => p.tab === this.tab)) return;
    if (this.wasRunning && !real) this.news = this.analyzeError ?? a?.error ? "blocked" : "done";
    this.wasRunning = real;
    if (this.analyzing() || spaces().some(s => s.active && s.tabs.some(c => c.id === this.tab && c.active))) this.news = null;
    const word = this.analyzing() ? "working" : this.news ?? null, all = shared(`${PANE}.status`) ?? {};
    const live = Object.entries(all).filter(([tab]) => tab !== this.tab && mine.some(p => p.tab === tab));
    // Every write redraws every mod: only a change, and tabs without a review pane drop out.
    if ((all[this.tab] ?? null) === word && live.length === Object.keys(all).length - (this.tab in all ? 1 : 0)) return;
    setShared(`${PANE}.status`, Object.fromEntries(word ? [...live, [this.tab, word]] : live));
  }

  // What this tab's pane shows, for the Review bar, which picks what it shows next: Herdr gives a mod pane no folder, and a
  // tab of its own has no terminal to borrow one from.
  publish() {
    const mine = this.inSidebar ? Object.keys(shared("review.sidebar") ?? {}).map(tab => ({ tab })) : panes().filter(p => p.mod === PANE);
    const key = this.inSidebar ? "review.sidebarShown" : `${PANE}.shown`;
    const all = shared(key) ?? {}, now = all[this.tab];
    if (!mine.some(p => p.tab === this.tab)) return;
    // The diff's commits, oldest first: on one commit's page, still its base's.
    const commits = this.baseCommits ?? (this.switching ? null : this.review?.commits) ?? [];
    const live = Object.entries(all).filter(([tab]) => tab !== this.tab && mine.some(p => p.tab === tab));
    // As report(): only a change, and tabs without a review pane drop out.
    if (now?.root === this.root && now.page === this.page && now.base === this.base && now.commits?.length === commits.length
      && commits.every((c, i) => c.sha === now.commits[i].sha) && live.length === Object.keys(all).length - 1) return;
    const shown = { root: this.root, page: this.page, base: this.base, commits: commits.map(c => ({ sha: c.sha, subject: c.subject, time: c.date ? new Date(c.date).getTime() : null })) };
    setShared(key, Object.fromEntries([...live, [this.tab, shown]]));
  }

  // The settings panel reads the daemon's agents and shared settings each time it opens: the browser may have changed them.
  loadSettings(cx) {
    const root = this.root;
    cx.spawn(async (cx) => {
      try {
        const [agents, shared] = await Promise.all([request(root, "GET", "/api/agents"), request(root, "GET", "/api/settings")]);
        this.agents = agents; this.shared = shared; this.settingsError = null;
        this.modelInput.set_value("");
      } catch (e) { this.settingsError = e?.message ?? String(e); }
      cx.notify();
    });
  }

  // Picking an agent or model makes the local agent the provider, as the app's Local agent settings do.
  saveLlm(patch, cx) {
    // Whether an agent is set up changes the Analyze button.
    this.saveShared({ ...this.shared, llm: { ...this.shared.llm, provider: "local-agent", ...patch } }, cx, true);
  }

  saveShared(next, cx, reload = false) {
    this.shared = next;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await request(this.root, "PUT", "/api/settings", next); this.settingsError = null; }
      catch (e) { this.settingsError = e?.message ?? String(e); }
      cx.notify();
      if (reload) this.load(cx);
    });
  }

  // The picked agent and model, the agent's catalog, and the models the search lists (past LISTED it must narrow them).
  models() {
    const llm = this.shared?.llm ?? {}, agent = llm.provider === "local-agent" ? llm.agent : "", model = llm.agentModel ?? "";
    const catalog = this.agents?.find(a => a.name === agent)?.models ?? [];
    const query = this.modelInput.value().trim().toLowerCase();
    const matches = query ? catalog.filter(m => `${m.id} ${m.name}`.toLowerCase().includes(query)) : catalog;
    return { agent, model, catalog, matches, shown: matches.slice(0, LISTED) };
  }

  /**
   * The settings, as the app's settings dialog in a panel: the view's choices, then the analysis's - analyzing on open,
   * and the language, agent and model, each a row naming its value. A row's press opens its list as a page of the panel,
   * as the app's selects open theirs (Herdr can't float a list over the rows after it); a pick, or Escape, comes back.
   */
  settingsPanel(t) {
    const page = this.settingsPage, locale = this.locale(), { agent, model, catalog, matches, shown } = this.models();
    const label = (text) => div().h(24).px(8).flex_none().flex().items_center().text_size(11).text_color(t.dim).child(text);
    const rule = () => div().h(1).my(4).mx(2).flex_none().bg(t.border);
    const link = (id, text, url) => div().id(id).text_color(t.muted).hover(s => s.text_color(t.foreground).underline()).role("link")
      .on_click((_e, cx) => { cx.stop_propagation(); openUrl(url); }).child(text);
    const note = (text, color = t.dim) => div().px(8).py(4).flex_none().text_color(color).child(text);
    const mark = (on) => div().w(14).flex_none().text_color(t.accent).when(on, el => el.child(svg("mods/review/check.svg").size(12)));
    const choice = (id, text, detail, on, pick, lit = false) => h_flex().id(id).h(28).px(8).gap(8).flex_none().items_center().rounded(6)
      .when(lit, el => el.bg(HOVER)).hover(s => s.bg(HOVER)).role("radio_button").accessibility_label(text).on_click((_e, cx) => pick(cx))
      .child(mark(on))
      .child(div().flex_1().min_w(0).truncate().child(text))
      .when(Boolean(detail), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(detail)));
    // A setting that opens its page: its name, its value and a chevron.
    const nav = (id, text, value) => h_flex().id(`settings-${id}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).hover(s => s.bg(HOVER))
      .role("button").accessibility_label(`${text}: ${value}`).on_click((_e, cx) => { this.settingsPage = id; cx.notify(); })
      .child(div().flex_none().child(text))
      .child(div().flex_1().min_w(0).truncate().text_right().text_color(t.dim).child(value))
      .child(svg("mods/review/chevron-right.svg").size(11).flex_none().text_color(t.dim));
    // A page's list scrolls where the panel runs short; everything above it stays put.
    const list = (items) => v_flex().id(`${page}-list`).min_h(0).flex_shrink_1().gap(2).overflow_y_scroll().children(items);
    const done = (cx) => { this.settingsPage = null; this.modelInput.set_value(""); this.modelIndex = -1; cx.notify(); };
    const pickModel = (id) => (cx) => { done(cx); this.saveLlm({ agentModel: id }, cx); };
    const current = this.agents?.find(a => a.name === agent);
    const custom = model && !catalog.some(m => m.id === model), typed = this.modelInput.value().trim();
    const rows = !page ? [
      label("View"),
      // Split needs a diff SPLIT_MIN wide: narrower, the choice is kept and the diff unified, so it shows faded.
      this.choiceRow(t, "Diff", [["view-unified", "Unified", !this.split], ["view-split", "Split", this.split, this.view < SPLIT_MIN]], (id, cx) => { if ((id === "view-split") !== this.split) this.toggleSplit(cx); }),
      this.choiceRow(t, "Files", [["files-tree", "Tree", this.fileList !== "list"], ["files-list", "List", this.fileList === "list"]], (id, cx) => {
        this.fileList = id === "files-list" ? "list" : "tree"; setPref("fileList", this.fileList); cx.notify();
      }),
      // The sidebar needs the pane WIDE: narrower, the choice is kept and the groups are tabs, so it shows faded.
      this.choiceRow(t, "Groups", [["groups-tabs", "Tabs", this.groupNav !== "sidebar"], ["groups-sidebar", "Sidebar", this.groupNav === "sidebar", this.width < WIDE]], (id, cx) => {
        this.groupNav = id === "groups-sidebar" ? "sidebar" : "tabs"; setPref("groupNav", this.groupNav); cx.notify();
      }),
      // Read by mods/pulls-review on the next open: a pane beside the agent, or a tab of its own.
      !this.inSidebar && this.choiceRow(t, "Open in", [["open-pane", "Pane", pref("openIn") !== "tab"], ["open-tab", "Tab", pref("openIn") === "tab"]], (id, cx) => {
        setPref("openIn", id === "open-tab" ? "tab" : "pane"); cx.notify();
      }),
      rule(),
      label("AI"),
      Switch.new("auto-analyze").checked(this.autoAnalyze).accessibility_label("Analyze automatically")
        .on_change((on, cx) => { this.autoAnalyze = on; setPref("autoAnalyze", on); cx.notify(); })
        .child(h_flex().h(28).px(8).gap(8).items_center().rounded(6).hover(s => s.bg(HOVER))
          .child(div().flex_1().child("Analyze automatically"))
          .child(div().w(28).h(16).p(2).flex_none().flex().rounded_full().bg(this.autoAnalyze ? t.accent : t.input)
            .when(this.autoAnalyze, el => el.justify_end())
            .child(div().size(12).rounded_full().bg(t.background)))),
      this.settingsError && note(this.settingsError, t.ansi1),
      // As the app's LanguageMenu, the language the analysis writes in (the pane's own words stay English): unset, the
      // daemon's default, the system's.
      this.shared && nav("language", "Language", LOCALES.find(([code]) => code === locale)?.[1] ?? locale ?? ""),
      !this.agents ? !this.settingsError && note("Looking for agents…")
        : this.agents.length ? nav("agent", "Agent", current ? `${current.label} ${current.version}` : "None") : note("No agent CLI found on PATH"),
      Boolean(current) && nav("model", "Model", !model ? "Default" : catalog.find(m => m.id === model)?.name ?? model),
      rule(),
      // Credit, as the app's footer: pulls.review is antfu's; this pane draws from JinJieBeWater's fork of it.
      h_flex().id("settings-credit").h(28).px(8).gap(4).flex_none().items_center().text_size(11).text_color(t.dim)
        .child(image(`mods/${PANE}/logo.svg`).w(12).h(12).flex_none().mr(2))
        .child(link("credit-upstream", "pulls.review", "https://github.com/antfu/pulls.review")).child("by")
        .child(link("credit-antfu", "@antfu", "https://github.com/antfu")).child("·")
        .child(link("credit-fork", "fork", "https://github.com/JinJieBeWater/pulls.review")).child("by")
        .child(link("credit-jinjie", "@JinJieBeWater", "https://github.com/JinJieBeWater")),
    ] : [
      h_flex().id("settings-back").h(28).px(8).gap(6).flex_none().items_center().rounded(6).hover(s => s.bg(HOVER))
        .role("button").accessibility_label("Back").on_click((_e, cx) => done(cx))
        .child(svg("mods/review/chevron-left.svg").size(11).flex_none().text_color(t.dim))
        .child(div().font_medium().child({ language: "Language", agent: "Agent", model: "Model" }[page])),
      rule(),
      page === "language" && list(LOCALES.map(([code, name]) => choice(`locale-${code}`, name, null, code === locale, (cx) => {
        done(cx); this.saveShared({ ...this.shared, locale: code }, cx);
      }))),
      page === "agent" && list((this.agents ?? []).map(a => choice(`agent-${a.name}`, a.label, a.version, a.name === agent, (cx) => {
        // One agent's model ids mean nothing to another: switching resets to its default.
        done(cx); this.saveLlm({ agent: a.name, agentModel: "" }, cx);
      }))),
      // The search sits above the catalog, which runs to hundreds for some agents.
      page === "model" && h_flex().h(28).px(8).gap(8).flex_none().items_center()
        .child(svg(`${LU}/search.svg`).size(12).w(14).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).h(24).px(6).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text()
          .child(Input.new(this.modelInput).flex_1().h_full().text_size(12).text_color(t.foreground))),
      page === "model" && list([
        choice("model-default", "Default", null, !model, pickModel("")),
        custom && choice("model-custom", model, "Custom", true, done),
        // Pi lists hundreds: past LISTED the search finds the rest.
        ...shown.map((m, i) => choice(`model-${m.id}`, m.name, null, m.id === model, pickModel(m.id), i === this.modelIndex)),
        shown.length < matches.length && note(`${matches.length - LISTED} more: search to narrow`),
        Boolean(typed) && !matches.length && note(`Enter to use “${typed}”`),
      ].filter(Boolean)),
    ];
    // Clipped: whatever outgrows the height scrolls inside its list, or is cut, rather than drawn past the panel.
    return this.popover(t, "review-settings-panel").w(320).max_h(Math.max(160, Math.min(520, this.height - 16))).overflow_hidden().p(6).gap(2)
      .children(rows.filter(Boolean));
  }

  // The language the analysis writes in: the one set, else the daemon's default.
  locale() { return this.shared?.locale ?? this.shared?.defaultLocale; }

  // A popup's button toggles it. A press on the button while open is also a press outside it, which already closed it:
  // that press mustn't reopen it. The settings read the daemon's agents and settings on opening: the browser may have changed them.
  togglePopup(name, cx) {
    if (this.popup === name) return this.closePopup(cx);
    if (this.closedPopup === name && Date.now() - this.popupClosedAt <= 300) return;
    this.popup = name;
    if (name === "settings") this.loadSettings(cx);
    cx.notify();
  }

  closePopup(cx) {
    if (!this.popup) return;
    this.closedPopup = this.popup; this.popup = null; this.popupClosedAt = Date.now();
    this.modelInput.set_value(""); this.modelIndex = -1; this.settingsPage = null;
    cx.notify();
  }

  // A popup's frame. It floats over the diff, and Herdr hands a press or a wheel to what's under it too: they stop here.
  // A press outside closes it.
  popover(t, id) {
    return v_flex().id(id).rounded(10).bg(t.popover).border_1().border_color(t.border).text_size(12).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => this.closePopup(cx));
  }

  // As the app's DiffCollapseMenu: every file of the diff at once, not just the group shown. The file at the view's top
  // (or its group's header) is brought back there, as folding the bodies above it would carry the view elsewhere.
  foldMenu(t) {
    const actions = [
      ["expand-all", "Expand all files", "unfold-vertical", false, () => true],
      ["collapse-all", "Collapse all files", "fold-vertical", true, () => true],
      ["collapse-reviewed", "Collapse reviewed files", "square-check", true, f => f.reviewed && !f.changed],
      ["collapse-tests", "Collapse test files", "flask", true, f => f.test],
    ];
    const run = (collapse, applies, cx) => {
      const top = (this.itemList ?? [])[this.visible?.start ?? 0];
      const anchor = top && (top.kind === "group" ? top.key : `f:${this.itemFile.get(top.key)}`);
      for (const f of this.review.files) if (applies(f)) collapse ? this.collapsed.add(f.path) : this.collapsed.delete(f.path);
      this.version++; this.closePopup(cx);
      const index = anchor ? this.items().findIndex(item => item.key === anchor) : -1;
      if (index >= 0) this.scrollToTop(index, cx);
    };
    return this.popover(t, "review-fold-menu").min_w(192).p(4).gap(2)
      .children(actions.map(([id, label, icon, collapse, applies]) => h_flex().id(`fold-${id}`).h(28).px(8).gap(8).items_center().rounded(6)
        .hover(s => s.bg(HOVER)).role("button").accessibility_label(label).on_click((_e, cx) => run(collapse, applies, cx))
        .child(svg(`${LU}/${icon}.svg`).size(14).flex_none().text_color(t.dim))
        .child(label)));
  }

  // Running or failed: what the status shows; with neither, as the app's dialog, it isn't shown.
  analysisStatus() {
    const a = this.review?.analysis, running = this.analyzing();
    return { running, error: this.analyzeError ?? (running ? null : a?.error) };
  }

  // As the app's AnalyzeStatusModal, without the transcript the daemon doesn't keep: what the run is doing in a faint line,
  // or why it failed, and once it's done a Re-run.
  statusPanel(t) {
    const { running, error } = this.analysisStatus();
    return this.popover(t, "review-status-panel").w(320).p(12).gap(10)
      .child(div().font_medium().text_size(13).child("AI analysis"))
      .when(running, el => el.child(h_flex().gap(6).items_center().opacity(0.4)
        .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().spin(900))
        .child(div().min_w(0).child(progressText(this.review.analysis.progress)))))
      .when(Boolean(error), el => el.child(div().text_color(t.ansi1).child(error)))
      .when(!running, el => el.child(h_flex().justify_end()
        .child(this.button(t, "rerun", "Re-run", (cx) => { this.closePopup(cx); this.analyze(cx, true); }, { primary: true, icon: `${LU}/rotate-cw.svg` }))));
  }

  // One file, or a folder's files at once. As the app's, marking folds the file and unmarking opens it again.
  setReviewed(files, reviewed, cx) {
    if (this.switching) return;
    files = [files].flat();
    for (const file of files) {
      file.reviewed = reviewed; file.changed = false;
      reviewed ? this.collapsed.add(file.path) : this.collapsed.delete(file.path);
    }
    this.version++; this.marks++; this.marking++;
    const { root, page } = this;
    cx.spawn(async (cx) => {
      try { await review(root, "/api/review/reviewed", { page, shas: files.map(file => file.sha), reviewed }); }
      catch (e) { this.error = e?.message ?? String(e); }
      // Read back what the daemon keeps, the marks of a failed press included.
      this.marking--;
      this.load(cx);
    });
    cx.notify();
  }

  // A removed or binary file has no new side to show whole.
  canFull(file) { return file.status !== "removed" && !file.isBinary; }

  toggleFull(file, cx) {
    if (this.switching || !this.canFull(file)) return;
    // As the app's button, disabled while the file loads: a click would cancel it, and its answer would open it again.
    if (this.full.has(file.path) && !this.full.get(file.path)) return;
    if (this.full.has(file.path)) { this.full.delete(file.path); this.version++; cx.notify(); return; }
    this.full.set(file.path, null);
    const { root, page } = this;
    cx.spawn(async (cx) => {
      let rows = null, error = null;
      try { rows = (await review(root, "/api/review/file", { page, file: file.path, colors: colors(theme()) })).rows; }
      catch (e) { error = e?.message ?? String(e); }
      // Another diff opened meanwhile: this file's rows are the old one's.
      if (root !== this.root || page !== this.page) return;
      if (rows) { this.full.set(file.path, rows); this.collapsed.delete(file.path); } else { this.full.delete(file.path); this.error = error; }
      this.version++;
      cx.notify();
    });
    cx.notify();
  }

  group() { return this.review?.groups.find(g => g.key === this.groupKey) ?? null; }

  // A press on a file's header, placed by x as item() lays the header out: the reviewed box at the start (12px in,
  // 14 wide), the fold and the whole-file slots at the end (24 wide each, 4 apart, 12px in). Anywhere else folds, as the app's.
  headerPress(file, x, cx) {
    if (this.switching) return;
    const fromEnd = this.view - x;
    if (x < 34) return this.setReviewed(file, !file.reviewed, cx);
    if (fromEnd > 36 && fromEnd <= 64 && this.canFull(file)) return this.toggleFull(file, cx);
    this.collapsed.has(file.path) ? this.collapsed.delete(file.path) : this.collapsed.add(file.path);
    this.version++;
    cx.notify();
  }

  // The reviewed box, drawn as the app's ReviewCheckbox: checked, partly (a folder), or not. Handlers are the caller's.
  // State "all", "some", "none", or "changed" (reviewed, then changed: the app's orange half mark).
  checkMark(t, state) {
    const fill = state === "changed" ? "#f97316" : state === "none" ? null : t.accent;
    return div().size(16).flex_none().rounded(4).border_1().border_color(fill ?? t.border).bg(fill ?? t.raised)
      .flex().items_center().justify_center().text_color("#ffffff")
      .when(state === "all", el => el.child(svg("mods/review/check.svg").size(10)))
      .when(state === "some" || state === "changed", el => el.child(svg("mods/review/minus.svg").size(10)));
  }

  // Rebuilt only when something it shows changed: render runs on every live change in Herdr.
  items() {
    const split = this.splitShown(), group = this.group(), id = `${this.version}:${this.groupKey}:${split}:${Math.round(this.view / 40)}`;
    if (id !== this.itemsId) {
      // The range last drawn was another list's: until this one draws, scrollToTop mustn't go by it.
      this.itemsId = id; this.visible = null;
      this.itemList = group ? buildItems(this.review, group, { collapsed: this.collapsed, full: this.full, split, width: this.view }) : [];
      this.sideWidth = split ? ["left", "right", "solo"].map(side => contentWidth(this.itemList, side)) : [0, 0, contentWidth(this.itemList)];
      this.itemFile = new Map(this.itemList.map(item => [item.key, item.file?.path ?? item.key.split(":")[1]]));
    }
    return this.itemList;
  }

  // How far code can scroll sideways: a split side (0 left, 1 right), or the full-width rows (2: unified ones, or a split
  // view's added and removed files), as far as its longest line runs past its width.
  sideMax(side) { return Math.max(0, this.sideWidth[side] - (side === 2 ? this.view : this.view / 2)); }

  select(path, cx, { scroll = true } = {}) {
    const owner = this.review.groups.find(g => groupFiles(g).includes(path));
    if (owner && owner.key !== this.groupKey) { this.groupKey = owner.key; this.version++; }
    this.current = path;
    if (scroll) {
      const index = this.items().findIndex(item => item.key === `f:${path}`);
      if (index >= 0) this.scrollToTop(index, cx);
    }
    cx.notify();
  }

  // The blank after the list, so its last header can still reach the top: a view's height less what follows that header.
  trailing() {
    const items = this.items(), total = items.reduce((n, item) => n + item.size, 0);
    let top = 0, last = 0;
    for (const item of items) { if (item.kind === "file" || item.kind === "group") last = top; top += item.size; }
    return Math.max(0, Math.ceil(this.listHeight - (total - last)));
  }

  /**
   * Brings an item's top to the list's top, exactly. The list scrolls only to the near edge: an item above the view lands at
   * the top, one below at the bottom. So below, first bottom-align the first item a view's height past it, which puts this
   * one just over the top; once that frame is drawn, scroll to this one, now above the view, so its top lands at the top.
   */
  scrollToTop(index, cx) {
    const sizes = [...this.items().map(item => item.size), this.trailing()], start = this.visible?.start ?? 0;
    const token = this.settling = {};
    if (index <= start) return this.scroll.scroll_to_item(index);
    let last = index, height = sizes[index];
    // A pixel's margin, so a rounded height still carries it past the top.
    while (height <= this.listHeight + 1 && last + 1 < sizes.length) height += sizes[++last];
    this.scroll.scroll_to_item(last);
    const drawn = this.frames;
    let tries = 0;
    const settle = (cx) => {
      if (this.settling !== token) return;
      if (this.frames > drawn) { this.scroll.scroll_to_item(index); cx.notify(); }
      else if (++tries < 30) cx.timer.after(8, settle);
    };
    cx.timer.after(8, settle);
  }

  step(delta, cx) {
    const group = this.group();
    if (!group) return;
    const files = groupFiles(group), at = files.indexOf(this.current);
    const next = files[Math.min(files.length - 1, Math.max(0, at + delta))];
    if (next) this.select(next, cx);
  }

  currentFile() { return this.review?.files.find(file => file.path === this.current) ?? null; }

  render(cx) {
    const t = theme();
    const request = this.inSidebar ? shared("review.sidebar")?.[focused()?.tab] : shared(PANE);
    if (this.inSidebar && !request) return v_flex().size_full().p(16).bg(t.background).text_color(t.muted).text_size(13).child("Choose changes from the Review bar.");
    if (!this.inSidebar) {
      // A pane may start before its new tab has focus: take the unclaimed review pane's tab.
      const mine = panes().filter(p => p.mod === PANE), titles = shared(`${PANE}.titles`) ?? {};
      if (!mine.some(p => p.tab === this.tab)) {
        const free = mine.filter(p => !(p.tab in titles));
        if (free.length === 1) { this.tab = free[0].tab; localStorage.setItem("tab", this.tab); }
      }
      const title = this.page ? pageLabel(this.page, this.switching ? null : this.review) : "review";
      const live = Object.fromEntries(Object.entries(titles).filter(([tab]) => mine.some(p => p.tab === tab)));
      if (mine.some(p => p.tab === this.tab) && (titles[this.tab] !== title || Object.keys(live).length !== Object.keys(titles).length)) setShared(`${PANE}.titles`, { ...live, [this.tab]: title });
      if (shared(`${PANE}.program`)?.icon !== `mods/${PANE}/logo.svg` || shared(`${PANE}.program`).inbox !== true) setShared(`${PANE}.program`, { icon: `mods/${PANE}/logo.svg`, tint: false, name: "Review", inbox: true });
    }
    this.report();
    // A later open in this tab: another page, maybe another worktree.
    if (request && (this.inSidebar || request.tab === this.tab) && (request.tab !== this.tab || request.n > this.handled)) {
      this.tab = request.tab;
      this.handled = request.n;
      if (request.root !== this.root) { this.root = request.root; this.watching = null; this.seen.clear(); this.collapsed.clear(); this.page = null; this.forget(); }
      // With a base, the Review bar picking another page of the same diff: its commits stay.
      this.base = request.base ?? request.page;
      if (!request.base) this.baseCommits = null;
      this.remember();
      this.open(request.page, cx);
    }
    this.publish();
    if (this.review && JSON.stringify(colors(t)) !== this.colorsKey) {
      for (const file of this.review.files) delete file.hunks;
      this.asked.clear(); this.version++;
      this.load(cx);
    }
    // The group shown has files without rows (just opened, or changed since): ask for them, once per version.
    const missing = !this.switching && this.group() && groupFiles(this.group()).map(path => this.review.files.find(f => f.path === path)).filter(f => f && !f.hunks && !this.asked.has(f.sha));
    if (missing?.length && !this.loading) this.load(cx);
    const wide = this.width >= WIDE, sidebar = this.sidebarShown(), group = this.group();
    // A group newly shown, however it came to be, opens its subgroups; its tab's caret folds them.
    if (this.groupKey !== this.expandedFor) { this.expandedFor = this.groupKey; this.expandedTab = this.groupKey; }
    // As the app below `lg`, where the header eats a big share of the screen: it slides away after a long scroll down and
    // comes back on any scroll up.
    const hidden = this.headerHidden && !wide;
    // As the app at `lg`: beside the diffs, an aside with the header and files of the group in view, a fifth of the row;
    // a chapter's header (a group with subgroups) across the row above. Narrower, the header leads the diffs. Either way it
    // shows only at the list's top, as the app's scrolls away with the diffs.
    const row = this.width - (sidebar ? 256 : 0);
    const column = () => v_flex().size_full().min_w(0).min_h(0)
      .when(!sidebar && !hidden, el => el.child(this.groupTabs(t)))
      .when(Boolean(group) && (!wide || group.children.length > 0) && this.atTop(), el => el.child(this.groupHeader(t, group)))
      .child(!wide ? div().flex_1().min_h(0).child(this.main(t, cx))
        : h_resizable("review-aside-width").flex_1().min_h(0)
          .child(resizable_panel().size(Math.max(ASIDE_MIN, Math.round(row / 5))).size_range(ASIDE_MIN, Math.max(ASIDE_MIN, Math.round(row * ASIDE_MAX_RATIO))).child(this.aside(t)))
          .child(resizable_panel().child(this.main(t, cx))));
    return v_flex().id("review-pane").relative().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .on_size_change((size, cx) => {
        const width = size.width / zoom(), height = size.height / zoom();
        if (Math.abs(width - this.width) >= 1 || Math.abs(height - this.height) >= 1) { this.width = width; this.height = height; cx.notify(); }
      })
      .when(!hidden, el => el.child(this.header(t, this.head())))
      .when(Boolean(this.error), el => el.child(h_flex().flex_none().px(12).py(6).gap(8).bg(t.ansi1 + "18").text_color(t.ansi1).text_size(12)
        .child(div().flex_1().min_w(0).child(this.error))
        .child(this.button(t, "retry", "Retry", () => this.load(cx)))))
      .child((!this.review
        // As the app's FeedbackLoading.
        ? div().flex_1().py(48).when(!this.error, el => el.child(h_flex().gap(8).items_center().justify_center().text_color(t.dim).role("status")
          .child(svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().spin(900)).child("Loading the review…")))
        // The divider drags; Herdr keeps the width under the group's id (renamed when the default changes, to take it).
        // As the app's group sidebar: w-64, at least 192, at most 40% of the page.
        : sidebar ? h_resizable("review-sidebar-width").flex_1().min_h(0)
          .child(resizable_panel().size(256).size_range(192, Math.max(192, Math.round(this.width * 0.4))).child(this.sidebar(t)))
          .child(resizable_panel().child(column()))
        : div().flex_1().min_h(0).child(column())).when(Boolean(this.switching), el => el.opacity(DISABLED)))
      // Built only while open: render runs on every live change, and a catalog runs to hundreds of rows.
      .when(this.popup === "settings", el => el.child(div().absolute().top(44).right(8).child(this.settingsPanel(t))))
      // Under its button, the one left of the gear.
      .when(this.popup === "fold" && Boolean(this.review) && !this.switching && !hidden, el => el.child(div().absolute().top(44).right(44).child(this.foldMenu(t))))
      // Under its button: right of it the fold menu's and the gear (24px each, 8px apart, 12px in), and the newer-commit
      // arrow while one commit is shown.
      .when(this.popup === "status" && Boolean(this.review) && !this.switching && (this.analysisStatus().running || Boolean(this.analysisStatus().error)), el => el.child(div().absolute().top(44).right(8).child(this.statusPanel(t))));
  }

  // Split as chosen, where the diff is wide enough for two sides; narrower it's unified, the choice kept.
  splitShown() { return this.split && this.view >= SPLIT_MIN; }

  // The sidebar as chosen, from WIDE, as the app's from `lg`; narrower the groups are tabs, the choice kept.
  sidebarShown() { return this.groupNav === "sidebar" && this.width >= WIDE; }

  toggleSplit(cx) {
    this.split = !this.split; setPref("split", this.split); this.version++;
    cx.notify();
  }

  key(e, cx) {
    // Typing a model name isn't a shortcut; Escape closes the panel.
    if (this.popup === "settings") {
      const count = this.models().shown.length;
      // Escape goes back a page, then closes.
      if (e.keystroke === "escape" && this.settingsPage) { this.settingsPage = null; cx.notify(); }
      else if (e.keystroke === "escape") this.closePopup(cx);
      else if ((e.keystroke === "down" || e.keystroke === "up") && count && this.settingsPage === "model") {
        const step = e.keystroke === "down" ? 1 : -1;
        this.modelIndex = this.modelIndex < 0 ? (step > 0 ? 0 : count - 1) : (this.modelIndex + step + count) % count;
        cx.stop_propagation(); cx.notify();
      }
      return;
    }
    const actions = {
      escape: () => this.closePopup(cx),
      j: () => this.step(1, cx), k: () => this.step(-1, cx),
      r: () => { const f = this.currentFile(); if (f) this.setReviewed(f, !f.reviewed, cx); },
      f: () => { const f = this.currentFile(); if (f) this.toggleFull(f, cx); },
      c: () => { if (this.current) { this.collapsed.has(this.current) ? this.collapsed.delete(this.current) : this.collapsed.add(this.current); this.version++; cx.notify(); } },
      s: () => this.toggleSplit(cx),
    };
    const action = actions[e.keystroke];
    // Switching, the list is the old page's: only Escape works.
    if (this.switching && e.keystroke !== "escape") return;
    if (action) { action(); cx.stop_propagation(); }
  }

  // The pane's buttons, text or icon, share one 24px height so a toolbar's controls line up.
  // As the app's ActionButton: bordered, faded until hovered (`btn-action`); `primary` filled; `note` dim words after the label.
  button(t, id, label, action, { color, icon, after, primary, spin, note } = {}) {
    return h_flex().id(id).h(24).px(8).gap(4).flex_none().items_center().rounded(6).text_size(12).border_1()
      .when(!primary, el => el.border_color(t.border).text_color(color ?? t.foreground).opacity(0.75).hover(s => s.opacity(1).bg(HOVER)))
      .when(Boolean(primary), el => el.border_color(t.accent).bg(t.accent).text_color("#ffffff").hover(s => s.opacity(0.9)))
      .role("button").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .when(Boolean(icon), el => el.child(svg(icon).size(12).flex_none().when(Boolean(spin), el => el.spin(900))))
      .child(label)
      .when(Boolean(note), el => el.child(div().opacity(FADE).child(note)))
      .when(Boolean(after), el => el.child(svg(after).size(11).flex_none()));
  }

  // As the app's ActionIconButton (`btn-icon-compact`): faded until hovered; `active` (its popup open) on the active tone.
  iconButton(t, id, icon, label, action, { color, spin, disabled, active } = {}) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(color ?? t.foreground)
      .when(Boolean(disabled), el => el.opacity(DISABLED))
      .when(!disabled, el => el.opacity(active ? 1 : FADE).when(Boolean(active), el => el.bg(ACTIVE)).hover(s => s.opacity(1).bg(HOVER)))
      .role("button").accessibility_label(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) action(cx); })
      .child(svg(icon).size(14).when(Boolean(spin), el => el.spin(900)));
  }


  // What the header shows: a title, the page, colored parts (theme color names) and buttons.
  head() {
    // Switching, the old page's counts and analysis aren't the new one's.
    const r = this.switching ? null : this.review, parts = [], buttons = [];
    if (r) {
      const files = r.files, done = files.filter(f => f.reviewed).length;
      parts.push({ text: `+${files.reduce((n, f) => n + f.additions, 0)}`, color: "ansi2" }, { text: `−${files.reduce((n, f) => n + f.deletions, 0)}`, color: "ansi1" },
        { text: `${done}/${files.length}`, color: "dim", donut: files.length ? done / files.length : 1 });
      buttons.push({ id: "fold-menu", icon: `${LU}/chevrons-up-down.svg`, label: "Expand or collapse files", active: this.popup === "fold", run: (cx) => this.togglePopup("fold", cx) });
    }
    // The view (unified or split, files as a tree or a list) is set in the settings, with the analysis.
    buttons.push({ id: "settings", icon: "mods/review/settings.svg", label: "Settings", active: this.popup === "settings", run: (cx) => this.togglePopup("settings", cx) });
    // The diff shown is named in the pane's own header (render's titles), so this one starts with the counts.
    return { parts, buttons };
  }

  header(t, head) {
    // Narrow, the counts give way and the buttons never.
    return h_flex().id("review-header").h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .children(head.parts.map(p => h_flex().min_w(0).gap(6).items_center().text_size(12).text_color(t[p.color] ?? t.dim)
        .when(p.donut !== undefined, el => el.child(this.donut(t, p.donut, 14)))
        .child(div().min_w(0).truncate().child(p.text))))
      .child(div().flex_1())
      .children(head.buttons.map(b => b.text
        ? this.button(t, b.id, b.text, b.run, { after: b.after, icon: b.lead, color: t[b.color], primary: b.primary, spin: b.spin, note: b.note })
        : this.iconButton(t, b.id, b.icon, b.label, b.run, { color: t[b.color], spin: b.spin, disabled: b.disabled, active: b.active })));
  }

  /**
   * The sidebar, as the app's DiffGroupSidebar: each group a row of its category icon, label and critical mark over its counts,
   * its donut and, with subgroups, a caret that hides them; its subgroups under it, one step in. The files are the aside's.
   */
  sidebar(t) {
    const visible = this.visibleGroups(), rows = [];
    const id = (g, depth) => `${depth}:${g.key}`;
    const open = (g, depth) => !this.folded.has(id(g, depth));
    const groupRow = (g, depth, top) => {
      const active = depth === 0 ? g.key === this.groupKey : top.key === this.groupKey && visible.has(g.key);
      const stats = this.groupStats(g), critical = g.critical || (g.children ?? []).some(c => c.critical), key = `side-g-${depth}-${g.key}`;
      // A subgroup shows itself in the list; a group shows itself and its subgroups.
      const pick = (cx) => {
        if (top.key !== this.groupKey) { this.groupKey = top.key; this.version++; }
        const index = depth ? this.items().findIndex(item => item.key === `g:${g.key}`) : 0;
        if (index >= 0) this.scrollToTop(index, cx);
        cx.notify();
      };
      return this.hoverable(h_flex().id(key).flex_none().items_center().pr(4).rounded(4), key)
        .when(depth === 0, el => el.mt(4)).when(depth > 0, el => el.pl(16).rounded_l(0))
        .when(active, el => el.bg(ACTIVE)).when(!active, el => el.hover(s => s.bg(HOVER)))
        .child(v_flex().id(`side-gb-${depth}-${g.key}`).flex_1().min_w(0).items_start().px(8).py(4).text_size(13)
          .opacity(active ? 1 : FADE).hover(s => s.opacity(1))
          .role("button").accessibility_label(g.label).on_click((_e, cx) => pick(cx))
          .child(h_flex().w_full().gap(6).items_center()
            .child(this.categoryIcon(t, g.category, 14, active || this.hovered === key))
            .child(div().min_w(0).truncate().child(g.label))
            .when(critical, el => el.child(this.criticalMark(t))))
          .child(h_flex().ml(24).gap(4).items_center().text_size(11)
            .child(this.diffStats(t, stats.added, stats.deleted))
            .child(div().opacity(0.4).child(`・${stats.count} ${stats.count === 1 ? "file" : "files"}`))))
        .when(stats.progress !== 0, el => el.child(this.donut(t, stats.progress, 16)))
        // As the app's: only a group with subgroups has a caret, and it shows or hides them.
        .when(depth === 0 && g.children.length > 0, el => el.child(this.caretButton(`side-fold-${g.key}`)
          .role("button").accessibility_label(open(g, depth) ? "Hide subgroups" : "Show subgroups")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); const k = id(g, depth); this.folded.has(k) ? this.folded.delete(k) : this.folded.add(k); cx.notify(); })
          .child(svg(`${LU}/chevron-${open(g, depth) ? "down" : "right"}.svg`).size(12))));
    };
    for (const g of this.review.groups) {
      rows.push(groupRow(g, 0, g));
      if (open(g, 0)) for (const child of g.children) rows.push(groupRow(child, 1, g));
    }
    return v_flex().id("review-sidebar").size_full().border_r(1).border_color(t.border)
      .child(v_flex().id("review-sidebar-rows").flex_1().min_h(0).py(12).pl(12).pr(8).gap(2).overflow_y_scrollbar().children(rows));
  }

  // Hovering an element colors the category icon in it, as the app's `group-hover:saturate-100`: Herdr has no group hover.
  hoverable(el, key) {
    return el.on_hover((on, cx) => { if (on) this.hovered = key; else if (this.hovered === key) this.hovered = null; cx.notify(); });
  }

  // A group's category icon in its hue (Tailwind's 300 on dark, 800 on light); unless `lit`, grey, as the app's `saturate-0`.
  categoryIcon(t, category, size, lit) {
    const [icon, dark, light] = CATEGORY[category] ?? CATEGORY.other, hue = isLight(t.background) ? light : dark;
    return svg(`${LU}/${icon}.svg`).size(size).flex_none().text_color(lit ? hue : grey(hue));
  }

  criticalMark(t, size = 14) {
    return svg(`${LU}/badge-alert.svg`).size(size).flex_none().text_color(isLight(t.background) ? "#d97706" : "#fbbf24");
  }

  // The group or subgroup at the list's top, as the app's aside sticks for the group scrolled to; before the list draws, its first.
  asideGroup() {
    const g = this.group(), items = this.itemList ?? [];
    if (!g) return null;
    for (let i = Math.min(this.visible?.start ?? 0, items.length - 1); i >= 0; i--) if (items[i].kind === "group") return items[i].group;
    return g.files.length || !g.children.length ? g : g.children[0];
  }

  // The files whose rows the list last drew, as the app marks the files in view.
  visibleFiles() {
    const { start = 0, end = 0 } = this.visible ?? {};
    return new Set((this.itemList ?? []).slice(start, end).filter(item => item.kind !== "group").map(item => this.itemFile.get(item.key)));
  }

  spied() { return this.review ? JSON.stringify([this.asideGroup()?.key, [...this.visibleFiles()], [...this.visibleGroups()], this.atTop(), this.stickyFile()?.path]) : ""; }

  // Whether the list is at its first item: the group's header shows only then.
  atTop() { return (this.visible?.start ?? 0) === 0; }

  // The file whose rows open the view once its header has scrolled past the top: that header sticks there, as the app's.
  stickyFile() {
    const item = (this.itemList ?? [])[this.visible?.start ?? 0];
    return item && item.kind !== "file" && item.kind !== "group" ? this.review.files.find(f => f.path === this.itemFile.get(item.key)) ?? null : null;
  }

  /**
   * As the app's group aside at `lg`, beside the diffs: for a subgroup or a group without subgroups, its header (a subgroup's
   * parent to go back to, its icon, label and critical mark over its counts and donut) and summary; then its own files.
   */
  aside(t) {
    const top = this.group(), g = this.asideGroup();
    if (!g) return div().id("review-aside");
    const parent = g === top ? null : top, stats = this.groupStats(g);
    return v_flex().id("review-aside").size_full().min_h(0).p(12).gap(12)
      .when(Boolean(parent) || !top.children.length, el => el.child(v_flex().id("aside-header").flex_none().w_full()
        .when(Boolean(parent), el => el.child(div().id("aside-parent").pb(4).pl(8).text_size(11).truncate().opacity(FADE).hover(s => s.opacity(1))
          .role("button").on_click((_e, cx) => { this.scrollToTop(0, cx); cx.notify(); }).child(`${parent?.label} ›`)))
        .child(v_flex().px(8).py(4).gap(4)
          .child(h_flex().gap(8).items_center()
            .child(this.categoryIcon(t, g.category, 16, true))
            .child(div().flex_1().min_w(0).truncate().text_size(18).font_medium().child(g.label))
            .when(Boolean(g.critical), el => el.child(this.criticalMark(t, 16))))
          .child(h_flex().gap(8).items_center().text_size(11)
            .child(this.diffStats(t, stats.added, stats.deleted))
            .child(div().opacity(FADE).child(`${stats.count} ${stats.count === 1 ? "file" : "files"}`))
            .child(this.donut(t, stats.progress, 12))))
        .when(Boolean(g.summary), el => el.child(div().pb(8).pl(8).border_b(1).border_color(t.border).opacity(FADE)
          .child(TextView.markdown(`aside-summary-${g.key}`, g.summary).selectable(true).scrollable(false).text_size(13))))))
      .child(v_flex().id("review-files").flex_1().min_h(0).overflow_y_scrollbar().children(this.fileTree(t, g)));
  }

  // As the app's FileTree, 0.5em in and 1em a level: a folder's box, icon and name; a file's box, its icon and path in the code
  // font (the folder dimmed, listed), test and critical marks, counts and status; a file in view on the active tone.
  fileTree(t, g) {
    const byPath = new Map(this.review.files.map(f => [f.path, f])), inView = this.visibleFiles(), light = isLight(t.background);
    const checkbox = (id, state, label, toggle) => this.checkMark(t, state).id(id).role("check_box").accessibility_label(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); toggle(cx); });
    // As the app's DisplayFilePath: its icon faded, the folder dimmed only listed. Herdr can't truncate mixed colors as one
    // text, so the folder gives way before the name.
    const path = (row, struck) => {
      const parts = row.name.split("/"), name = parts.pop();
      return h_flex().flex_1().min_w(0).gap(4).items_center().font_family(MONO)
        .child(image(`${CAT}/${fileIcon(row.path)}.svg`).w(16).h(16).flex_none().opacity(FADE))
        .when(parts.length > 0, el => el.child(div().min_w(0).flex_shrink(100).truncate().when(struck, el => el.line_through()).when(this.fileList === "list", el => el.opacity(0.4)).child(`${parts.join("/")}/`)))
        .child(div().min_w(0).flex_shrink_1().truncate().when(struck, el => el.line_through()).child(name));
    };
    return fileRows(g.files, g.missing, this.fileList).map(row => {
      const base = h_flex().h(24).flex_none().pl(6 + row.depth * 13).pr(4).gap(6).items_center().rounded(4).text_size(13);
      if (row.type === "folder") {
        const files = row.paths.map(path => byPath.get(path)).filter(Boolean), done = files.filter(f => f.reviewed).length;
        const state = !done ? "none" : done === files.length ? "all" : "some";
        return base.id(`tree-d-${row.key}`)
          .child(checkbox(`tree-dcheck-${row.key}`, state, `${row.name}: ${done} of ${files.length} reviewed`, (cx) => this.setReviewed(files, state !== "all", cx)))
          .child(image(`${CAT}/${folderIcon(row.name)}.svg`).w(16).h(16).flex_none().opacity(FADE))
          .child(div().min_w(0).truncate().opacity(FADE).child(row.name));
      }
      if (row.type === "missing")
        return base.id(`tree-m-${row.key}`).opacity(0.5)
          .child(div().w(16).flex_none())
          .child(path(row, true))
          .child(div().flex_none().text_size(11).child("removed"));
      const f = byPath.get(row.path);
      if (!f) return null;
      const state = f.changed ? "changed" : f.reviewed ? "all" : "none";
      const critical = [g, ...g.children].some(x => (x.notes[f.path] ?? []).some(note => note.critical));
      return base.id(`tree-f-${row.path}`)
        .when(inView.has(row.path), el => el.bg(ACTIVE))
        .when(!inView.has(row.path) && f.test, el => el.bg(t.ansi2 + "14"))
        // A file's row shows it: the app gives it no hover, but every other thing to press here has one.
        .when(!inView.has(row.path), el => el.hover(s => s.bg(HOVER)))
        .on_click((_e, cx) => this.select(row.path, cx))
        .child(checkbox(`tree-check-${row.path}`, state, f.reviewed ? `${row.path}: reviewed` : `${row.path}: not reviewed`, (cx) => this.setReviewed(f, !f.reviewed, cx)))
        .child(path(row, false))
        .when(f.test, el => el.child(svg(`${LU}/flask-conical.svg`).size(14).flex_none().text_color(light ? "#15803d" : "#4ade80")))
        .when(critical, el => el.child(this.criticalMark(t)))
        .child(div().flex_none().text_size(11).child(this.diffStats(t, f.additions, f.deletions)))
        .child(this.fileStatus(f.status));
    }).filter(Boolean);
  }

  // A setting's row: its name, then its options as one segmented control; `pick(id, cx)` on a press.
  choiceRow(t, name, options, pick) {
    return h_flex().h(32).px(8).gap(8).flex_none().items_center()
      .child(div().flex_1().child(name))
      // As the app's ActionToggleGroup: a sunken track, the picked option raised; the others brighten on hover.
      .child(h_flex().flex_none().p(2).gap(2).rounded(8).bg(sunken(t))
        .children(options.map(([id, text, on, faded]) => div().id(id).h(22).px(10).flex().items_center().rounded(6)
          .text_color(on ? t.foreground : t.dim).when(on, el => el.bg(raised(t)).shadow_sm()).when(!on, el => el.hover(s => s.text_color(t.foreground)))
          .when(Boolean(faded), el => el.opacity(0.5))
          .role("radio_button").accessibility_label(`${name}: ${text}`)
          .on_click((_e, cx) => pick(id, cx))
          .child(text))));
  }

  // As the app's ActionIconButton (`btn-icon`) at text-xs: round, faded until hovered, then on the app's translucent
  // hover tone, which stacks over a hovered row's. Handlers and icon are the caller's.
  caretButton(id) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded_full()
      .opacity(FADE).hover(s => s.opacity(1).bg(HOVER));
  }

  // As the app's DiffStats: the additions and the deletions, each only when there are any.
  diffStats(t, added, deleted) {
    return h_flex().flex_none().gap(4)
      .when(added > 0, el => el.child(div().text_color(t.ansi2).child(`+${added.toLocaleString()}`)))
      .when(deleted > 0, el => el.child(div().text_color(t.ansi1).child(`-${deleted.toLocaleString()}`)));
  }

  // As the app's FileStatus: the letter in its status's color, on a tenth of it.
  fileStatus(status) {
    const [letter, color] = FILE_STATUS[status] ?? FILE_STATUS.modified;
    return div().w(16).flex_none().flex().items_center().justify_center().rounded(4).font_family(MONO).text_size(11).text_color(color).bg(color + "1a").child(letter);
  }

  main(t, cx) {
    const items = this.items(), sticky = this.stickyFile();
    this.stuck = Boolean(sticky);
    return v_flex().size_full().min_w(0).overflow_hidden()
      .child(div().id("review-diff-area").flex_1().min_h(0).overflow_hidden().relative().text_size(12)
        .on_size_change((size, cx) => {
          this.listHeight = size.height / zoom();
          if (Math.abs(size.width / zoom() - this.view) >= 1) { this.view = size.width / zoom(); cx.notify(); }
        })
        // Code scrolls sideways by the wheel: split, each side under the pointer; the full-width rows under either.
        // Headers and notes stay put, and the list keeps the vertical.
        .on_scroll_wheel((event, cx) => {
          let moved = false, sideways = false;
          // How far this run down has gone (a negative delta scrolls down, as sideways); any scroll up restarts it.
          const dy = event.delta.y / zoom();
          if (dy > 0) this.scrolledDownBy = 0;
          else if (dy < 0) this.scrolledDownBy -= dy;
          const hide = this.scrolledDownBy > 300;
          if (hide !== this.headerHidden) { this.headerHidden = hide; moved = true; }
          for (const side of this.splitShown() ? [(event.local_position?.x ?? 0) / zoom() < this.view / 2 ? 0 : 1, 2] : [2]) {
            const x = Math.min(this.sideMax(side), Math.max(0, this.shift[side] - event.delta.x / zoom()));
            if (x !== this.shift[side]) { this.shift[side] = x; moved = sideways = true; }
          }
          if (sideways) {
            const run = ++this.barsRun;
            this.barsOn = true;
            cx.timer.after(BARS_LINGER, (cx) => { if (run === this.barsRun) { this.barsOn = false; cx.notify(); } });
          }
          if (moved) cx.notify();
        })
        // A row reports only its key: where the press landed says which part of a file's header it was for.
        .on_mouse_down("left", (event) => { this.pressX = (event.local_position?.x ?? 0) / zoom(); this.pressY = (event.local_position?.y ?? 0) / zoom(); })
        // A blank after the items (trailing) lets the last header reach the top.
        .child(v_virtual_list("review-diff", items.length + 1, [...items.map(item => item.size), this.trailing()], (i) => items[i]?.key ?? "end",
          // The range drawn is the only word on where the list is scrolled, and its frames on when a scroll has landed.
          (range) => {
            this.visible = range; this.frames++;
            return Array.from({ length: range.end - range.start }, (_, k) => items[range.start + k] ? this.item(t, items[range.start + k]) : div().w_full().h(this.trailing()));
          })
          .track_scroll(this.scroll).size_full()
          .on_item_click((key, cx) => {
            // A press on the stuck header lands on the row under it too: the header has it.
            if (this.stuck && this.pressY < FILE) return;
            const file = this.review.files.find(f => f.path === this.itemFile.get(key));
            if (!file) return;
            if (key.startsWith("f:")) this.headerPress(file, this.pressX ?? 0, cx);
            this.select(file.path, cx, { scroll: false });
          }))
        // Folding or marking the file from its stuck header folds it away under the top: its header, above the view, comes
        // back to the top in one scroll (the list scrolls to the near edge).
        .when(Boolean(sticky), el => el.child(div().id("sticky-file").absolute().top(0).left(0).w_full()
          .on_click((_e, cx) => {
            const open = !this.collapsed.has(sticky.path);
            this.headerPress(sticky, this.pressX ?? 0, cx);
            this.select(sticky.path, cx, { scroll: false });
            const at = this.items().findIndex(item => item.key === `f:${sticky.path}`);
            if (open && this.collapsed.has(sticky.path) && at >= 0) this.scroll.scroll_to_item(at);
          })
          .child(this.item(t, { key: `f:${sticky.path}`, kind: "file", file: sticky, size: FILE }))))
        .child(Scrollbar.vertical("review-diff").absolute().inset_0())
        .children(this.hbars(t))
        .when(!items.length, el => el.child(div().absolute().top(8).px(12).text_color(t.dim).child("No files in this group"))));
  }

  // Code scrolls sideways by the wheel alone: while it does, as an overlay scrollbar, a 4px bar says where it is, for each
  // overflowing side with rows in view. Split, the full-width rows' sits above the halves' when both show.
  hbars(t) {
    const { start = 0, end = 0 } = this.visible ?? {}, split = this.splitShown();
    const kinds = new Set((this.itemList ?? []).slice(start, end).map(item => item.kind));
    const sides = (split ? [0, 1, 2] : [2]).filter(side => this.sideMax(side) > 0 && kinds.has(side < 2 ? "pair" : split ? "solo" : "row"));
    return sides.map(side => {
      const width = side === 2 ? this.view : this.view / 2, max = this.sideMax(side);
      const thumb = Math.max(24, width * width / this.sideWidth[side]);
      return div().id(`hbar-${side}`).absolute().bottom(side === 2 && sides.length > 1 ? 8 : 2).left(side === 1 ? this.view / 2 : 0).w(width).h(4)
        .opacity(this.barsOn ? 1 : 0).transition("opacity", { duration: 150, easing: "ease-out" })
        .child(div().absolute().left((width - thumb) * Math.min(this.shift[side], max) / max).w(thumb).h_full().rounded_full().bg(t.muted + "80"));
    });
  }

  groupHeader(t, g) {
    return v_flex().id("group-header").flex_none().max_h(220).overflow_hidden().px(12).py(10).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .when(g.critical, el => el.child(div().px(5).rounded(4).bg(t.blocked + "26").text_size(11).text_color(t.blocked).child("Needs care")))
        .child(div().font_semibold().child(g.label)))
      .when(Boolean(g.summary), el => el.child(TextView.markdown(`summary-${g.key}`, g.summary).selectable(true).scrollable(false).text_size(12).text_color(t.muted)))
      // Without the sidebar, as the app's chapter header: its subgroups to jump to, in one row as the tabs', unless its tab's
      // caret folded them. Scrolled away, they stick under the tabs instead.
      .when(!this.sidebarShown() && g.children.length > 0 && this.expandedTab === g.key, el => el.child(h_flex().id("group-sub-row").pt(1).gap(6).overflow_x_scroll()
        .children(g.children.map(child => this.groupTab(t, `group-sub-${child.key}`, { ...child, children: [] }, { pick: (cx) => this.showSubgroup(g, child, cx) })))));
  }

  // As the app's countGroupStats, countGroupFiles and groupProgress: a group's own files and its subgroups'.
  groupStats(g) {
    const files = groupFiles(g).map(path => this.review.files.find(f => f.path === path)).filter(Boolean);
    return {
      added: files.reduce((n, f) => n + f.additions, 0), deleted: files.reduce((n, f) => n + f.deletions, 0), count: files.length,
      progress: files.length ? files.filter(f => f.reviewed).length / files.length : 1,
    };
  }

  // As the app's DisplayDonut: a faint ring, and from the top, clockwise, an arc as far as `value`.
  donut(t, value, size = 18) {
    const z = zoom(), c = size / 2 * z, r = (size / 2 - 2) * z, ring = (b) => b.move_to(c, c - r).arc_to(r, r, 0, false, true, c, c + r).arc_to(r, r, 0, false, true, c, c - r);
    const a = 2 * Math.PI * Math.min(value, 1), arc = value >= 1 ? ring(PathBuilder.stroke(2 * z))
      : PathBuilder.stroke(2 * z).move_to(c, c - r).arc_to(r, r, 0, value > 0.5, true, c + r * Math.sin(a), c - r * Math.cos(a));
    return div().size(size).flex_none().relative()
      .child(window.paint_path(ring(PathBuilder.stroke(2 * z)).build(), t.border).absolute().top(0).left(0).size_full())
      .when(value > 0, el => el.child(window.paint_path(arc.build(), t.foreground).absolute().top(0).left(0).size_full()));
  }

  /**
   * One group as the app's DiffGroupNavItem: a tab, bordered but for its foot, which is 2px and the category's hue when the
   * tab is the one shown (raised a pixel, on a shadow). Its category icon (grey until shown), label and critical mark over
   * its counts; its progress as a donut; with subgroups and a `toggle`, a caret that opens them.
   */
  groupTab(t, id, g, { active = false, expanded = false, toggle, pick }) {
    const [, darkHue, lightHue] = CATEGORY[g.category] ?? CATEGORY.other, hue = isLight(t.background) ? lightHue : darkHue;
    const stats = this.groupStats(g), subgroups = g.children?.length ?? 0, critical = g.critical || (g.children ?? []).some(c => c.critical);
    return this.hoverable(v_flex().id(id), id).flex_none().rounded_t(4).border_t(1).border_l(1).border_r(1).border_color(t.border).bg(t.background)
      .when(active, el => el.relative().top(-1).shadow_sm())
      .child(h_flex().id(`${id}-button`).px(8).py(2).gap(8).items_center().text_size(13).text_color(t.foreground)
        .opacity(active ? 1 : FADE).hover(s => s.opacity(1).bg(ACTIVE))
        .role("tab").accessibility_label(g.label).on_click((_e, cx) => pick(cx))
        .child(v_flex().items_start()
          .child(h_flex().gap(6).items_center()
            .child(this.categoryIcon(t, g.category, 14, active || this.hovered === id))
            .child(g.label)
            .when(critical, el => el.child(this.criticalMark(t))))
          .child(h_flex().items_center().text_size(11)
            .when(stats.added > 0, el => el.child(div().text_color(t.ansi2).child(`+${stats.added.toLocaleString()}`)))
            .when(stats.deleted > 0, el => el.child(div().ml(4).text_color(t.ansi1).child(`-${stats.deleted.toLocaleString()}`)))
            .child(div().text_color(t.dim).child(`・${stats.count} ${stats.count === 1 ? "file" : "files"}`))
            .when(subgroups > 0, el => el.child(div().text_color(t.dim).child(`・${subgroups} ${subgroups === 1 ? "subgroup" : "subgroups"}`)))))
        .when(stats.progress !== 0, el => el.child(this.donut(t, stats.progress)))
        // Not the app's `mr--1`: a negative margin here has Herdr's layout squeeze the whole tab under its neighbour.
        .when(subgroups > 0 && Boolean(toggle), el => el.child(this.caretButton(`${id}-caret`)
          .role("button").accessibility_label(expanded ? "Hide subgroups" : "Show subgroups")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); toggle(cx); })
          .child(svg(`${LU}/chevron-${expanded ? "up" : "down"}.svg`).size(12)))))
      .child(div().h(2).w_full().bg(active ? hue : t.border));
  }

  // The subgroups whose rows the list last drew, as the app marks the groups in view.
  visibleGroups() {
    const keys = new Set(), items = this.itemList ?? [], { start = 0, end = 0 } = this.visible ?? {};
    let current = null;
    for (let i = 0; i < Math.min(end, items.length); i++) {
      if (items[i].kind === "group") current = items[i].group.key;
      if (i >= start && current) keys.add(current);
    }
    return keys;
  }

  // Shows a subgroup: its group first, if another is shown, then its header at the top.
  showSubgroup(parent, child, cx) {
    if (parent.key !== this.groupKey) { this.groupKey = parent.key; this.version++; }
    const index = this.items().findIndex(item => item.key === `g:${child.key}`);
    if (index >= 0) this.scrollToTop(index, cx);
    cx.notify();
  }

  /**
   * Narrower than WIDE, as the app's DiffGroupNav below `lg`: the groups as tabs over the diff, but one row that scrolls
   * sideways rather than wrapping, so they keep to one line. Picking one shows it and opens its subgroups in a row under
   * them ("subgroups of …"), as its caret does; for the group shown, only once its header has scrolled away.
   */
  groupTabs(t) {
    // Not the group shown while its header, at the list's top, lists them: one place at a time, as a sticky header.
    const open = this.review.groups.find(g => g.key === this.expandedTab && g.children.length && !(g.key === this.groupKey && this.atTop()));
    // The shown tab is raised a pixel: each row's top pixel keeps it from the clip.
    const row = (id) => h_flex().id(id).pt(1).gap(6).overflow_x_scroll();
    return v_flex().id("group-tabs").flex_none().px(12).pt(9).pb(8).gap(6).border_b(1).border_color(t.border)
      .child(row("group-tab-row").children(this.review.groups.map(g => this.groupTab(t, `group-tab-${g.key}`, g, {
        active: g.key === this.groupKey, expanded: this.expandedTab === g.key,
        toggle: (cx) => { this.expandedTab = this.expandedTab === g.key ? null : g.key; cx.notify(); },
        pick: (cx) => {
          if (g.key !== this.groupKey) { this.groupKey = g.key; this.version++; this.scrollToTop(0, cx); }
          this.expandedTab = g.key;
          cx.notify();
        },
      }))))
      .when(Boolean(open), el => el
        .child(h_flex().gap(4).items_center().text_size(13)
          .child(svg(`${LU}/folder-open.svg`).size(14).flex_none().opacity(FADE))
          .child(div().opacity(FADE).child("subgroups of"))
          .child(div().child(open.label))
          .child(div().flex_1().h(1).bg(t.border)))
        .child(row("group-subtab-row").children(open.children.map(child => this.groupTab(t, `group-subtab-${child.key}`, { ...child, children: [] }, {
          active: this.visibleGroups().has(child.key), pick: (cx) => this.showSubgroup(open, child, cx),
        })))));
  }

  // One side of a line: its line numbers (one in split, old and new in unified), its sign and its code, slid left by `shift`.
  code(t, row, numbers, shift = 0) {
    if (!row) return div().flex_1().min_w(0).h_full().bg(t.canvas);
    const tint = row.kind === "+" ? t.ansi2 + "1c" : row.kind === "-" ? t.ansi1 + "1c" : null;
    // Herdr ships JetBrains Mono; Geist Mono, a common terminal font here, draws `=>` over the space before it.
    return h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden().font_family(MONO).when(Boolean(tint), el => el.bg(tint))
      .children(numbers.map(number => div().w(40).flex_none().pr(6).text_right().text_color(t.dim).child(number === undefined ? "" : String(number))))
      .child(div().w(12).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim).child(row.kind === " " ? "" : row.kind))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
        .child(h_flex().flex_none().relative().left(-shift)
          .children(spans(row.tokens.slice(0, 400)).map(([text, color]) => div().flex_none().text_color(color ?? t.foreground).child(text)))));
  }

  item(t, item) {
    switch (item.kind) {
      case "file": {
        // As the app's file header: the reviewed box, the path and its marks; the counts, the status, the whole file and the fold.
        // A row holds no handlers: headerPress places a press by these parts' positions.
        const f = item.file, open = !this.collapsed.has(f.path), full = this.full.has(f.path), loading = full && !this.full.get(f.path);
        const slot = () => div().size(24).flex_none().flex().items_center().justify_center();
        return h_flex().w_full().h(item.size).px(12).gap(8).items_center().border_t(1).border_b(1).border_color(t.border)
          .bg(this.current === f.path ? t.selected : t.chrome)
          .child(this.checkMark(t, f.changed ? "changed" : f.reviewed ? "all" : "none"))
          .child(div().min_w(0).flex_shrink_1().truncate().when(f.reviewed, el => el.text_color(t.dim)).child(f.previousPath ? `${f.previousPath} → ${f.path}` : f.path))
          .when(f.test, el => el.child(svg(`${LU}/flask-conical.svg`).size(14).flex_none().text_color(isLight(t.background) ? "#15803d" : "#4ade80")))
          .when(f.noisy, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("generated")))
          .when(f.changed, el => el.child(div().flex_none().text_size(11).text_color(t.ansi3).child("changed since reviewed")))
          .child(div().flex_1())
          .when(!f.isBinary, el => el.child(div().flex_none().text_size(11).child(this.diffStats(t, f.additions, f.deletions))))
          .when(f.isBinary, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("binary")))
          .child(this.fileStatus(f.status))
          .child(h_flex().flex_none().gap(4)
            .child(slot().when(this.canFull(f), el => el.child(svg(loading ? "mods/workspace-chrome/spinner.svg" : "mods/review/file-text.svg").size(14).text_color(full ? t.accent : t.dim).when(loading, s => s.spin(900)))))
            .child(slot().child(svg(`mods/review/chevron-${open ? "down" : "right"}.svg`).size(12).text_color(t.dim))));
      }
      case "group":
        return h_flex().w_full().h(item.size).px(12).gap(8).items_center().font_semibold().text_color(t.ansi4)
          .when(item.group.critical, el => el.child(div().text_color(t.blocked).child("!")))
          .child(div().min_w(0).truncate().child(item.group.label));
      case "hunk":
        // Hunk headers on the raised tone, as Herdr's own changes diff draws them.
        return div().w_full().h(item.size).px(12).flex().items_center().bg(t.raised).font_family(MONO).text_color(t.dim).truncate().child(item.text);
      case "note": {
        // As the app's AnalysisNoteCard: a sparkle, or a critical note's mark, then its Markdown in the UI font.
        // A file's own notes run across the file under its header; a line's sits under the line as a card.
        const { note } = item, critical = note.critical;
        const body = h_flex().gap(8).items_start().overflow_hidden()
          .child(critical
            ? div().w(12).flex_none().font_bold().text_color(t.blocked).child("!")
            : svg(`${LU}/sparkles.svg`).size(12).mt(3).flex_none().text_color(t.dim))
          // Markdown in a row wraps at the row's width, past the mark and padding: a column of the measured width holds it.
          .child(v_flex().w(noteWidth(this.view, item.anchored)).flex_none()
            .child(TextView.markdown(`note-${item.key}`, note.text).selectable(true).scrollable(false).text_size(12).text_color(t.foreground)));
        return item.anchored
          ? div().w_full().h(item.size).px(8).py(3)
            .child(body.w_full().max_w(800).h_full().px(10).py(4).rounded(8).border_1()
              .border_color(critical ? t.blocked + "4d" : t.border).bg(critical ? t.blocked + "1a" : t.background))
          : body.w_full().h(item.size).px(12).py(6).when(critical, el => el.bg(t.blocked + "1a"))
            .when(Boolean(item.last), el => el.border_b(1).border_color(t.border));
      }
      case "empty":
        return div().w_full().h(item.size).pl(codeInset(this.splitShown())).pr(12).gap(8).flex().items_center().text_color(t.dim)
          .when(Boolean(item.loading), el => el.child(svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().spin(900))).child(item.text);
      default:
        return v_flex().w_full().h(item.size).children(item.lines.map(line => this.line(t, item.kind, line)));
    }
  }

  // One code line of a run, ROW tall.
  line(t, kind, line) {
    if (kind === "pair") {
      return h_flex().w_full().h(ROW)
        .child(this.code(t, line.left, [line.left?.old], Math.min(this.shift[0], this.sideMax(0))))
        .child(div().w(1).h_full().flex_none().bg(t.border))
        .child(this.code(t, line.right, [line.right?.new], Math.min(this.shift[1], this.sideMax(1))));
    }
    const numbers = kind === "solo" ? [line.kind === "-" ? line.old : line.new] : [line.old, line.new];
    return h_flex().w_full().h(ROW).child(this.code(t, line, numbers, Math.min(this.shift[2], this.sideMax(2))));
  }
}
