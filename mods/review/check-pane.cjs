// Modified for herdr-config: verify sidebar navigation and absence of the AI review button.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// rows.js runs as is; main.js runs on inert elements, to reach every render path with a review in hand.
const load = (file, env) => {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8")
    .replace(/^import [^;]*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class").replace(/^export /gm, "");
  const context = vm.createContext(env);
  vm.runInContext(src, context, { filename: file });
  return context;
};
// Values made in another realm compare unequal to this one's: compare them as JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));
const rows = load("rows.js", {});
const { pairRows, buildItems, noteHeight, pageLabel, groupFiles, contentWidth, fileRows, codeInset, noteWidth } = vm.runInContext("({ pairRows, buildItems, noteHeight, pageLabel, groupFiles, contentWidth, fileRows, codeInset, noteWidth })", rows);

const row = (kind, old, next) => ({ kind, old, new: next, tokens: [[`${kind}${old ?? ""}:${next ?? ""}`]] });
// A run of deletions faces the additions after it; context faces itself.
const pairs = pairRows([row(" ", 1, 1), row("-", 2), row("-", 3), row("+", undefined, 2), row(" ", 4, 3), row("+", undefined, 4)]);
assert.deepEqual(plain(pairs.map(p => [p.left?.old ?? null, p.right?.new ?? null])), [[1, 1], [2, 2], [3, null], [4, 3], [null, 4]]);

const file = (p, extra = {}) => ({ path: p, sha: p, status: "modified", additions: 1, deletions: 1, isBinary: false, reviewed: false, changed: false, noisy: false, test: false, hunks: [{ header: "@@ -1,2 +1,2 @@", rows: [row(" ", 1, 1), row("-", 2), row("+", undefined, 2)] }], ...extra });
const review = {
  title: "t", base: { ref: "origin/main" }, head: { sha: "h" }, commits: [{ sha: "c1", subject: "one" }, { sha: "c2", subject: "two" }], source: "llm",
  files: [file("a.ts"), file("b.png", { isBinary: true, hunks: [] }), file("c.ts")],
  groups: [{ key: "g", label: "G", summary: "**why**", category: "core", critical: true, missing: ["gone.ts"], files: ["a.ts", "b.png"],
    notes: { "a.ts": [{ text: "whole file", critical: false }, { text: "on the new line 2", critical: true, anchor: { side: "additions", line: 2 } }] },
    children: [{ key: "k", label: "K", category: "tests", critical: false, missing: [], files: ["c.ts"], notes: {}, children: [] }] }],
  analysis: { state: "current", model: "pi/m", agent: true },
};
const kinds = (items) => plain(items).map(item => item.key.split(":")[0] + (item.kind === "note" ? `(${item.note.text})` : item.lines ? item.lines.length : ""));
const opts = { collapsed: new Set(), full: new Map(), split: false, width: 900 };
// Unanchored notes under the header, an anchored one under its line, children after their header.
assert.deepEqual(kinds(buildItems(review, review.groups[0], opts)), ["f", "n(whole file)", "h", "r3", "n(on the new line 2)", "f", "e", "g", "f", "h", "r3"]);
assert.deepEqual(plain(groupFiles(review.groups[0])), ["a.ts", "b.png", "c.ts"]);
// Collapsed files show only their header; a whole file replaces the hunks; split pairs the rows.
assert.deepEqual(kinds(buildItems(review, review.groups[0], { ...opts, collapsed: new Set(["a.ts", "c.ts"]) })), ["f", "f", "e", "g", "f"]);
assert.deepEqual(kinds(buildItems(review, review.groups[0], { ...opts, full: new Map([["a.ts", [row(" ", 1, 1), row("+", undefined, 2)]]]), collapsed: new Set(["c.ts"]) })), ["f", "n(whole file)", "r2", "n(on the new line 2)", "f", "e", "g", "f"]);
assert.deepEqual(kinds(buildItems(review, review.groups[0], { ...opts, split: true, collapsed: new Set(["c.ts"]) })), ["f", "n(whole file)", "h", "r2", "n(on the new line 2)", "f", "e", "g", "f"]);
// Code lines go in runs of up to 32, a line's note ending one: a few thousand changed lines stay far under v_virtual_list's 10000 items.
const lines = (n) => Array.from({ length: n }, (_, i) => row("+", undefined, i + 1));
const one = (n, notes = {}) => buildItems({ ...review, files: [file("x.ts", { hunks: [{ header: "@@", rows: lines(n) }] })] }, { key: "x", files: ["x.ts"], notes, children: [] }, opts);
assert.deepEqual(kinds(one(70, { "x.ts": [{ text: "here", critical: false, anchor: { side: "additions", line: 40 } }] })), ["f", "h", "r32", "r8", "n(here)", "r30"]);
const big = plain(one(20000));
assert.ok(big.length < 1000 && big.filter(item => item.lines).every(item => item.size === item.lines.length * 20));
assert.equal(big.reduce((n, item) => n + (item.lines?.length ?? 0), 0), 20000);
assert.ok(noteHeight("测".repeat(200), 900, true) > noteHeight("a".repeat(200), 900, true));
// A line's note is a card at most 800 wide, so it wraps sooner than a file's own note across a wide view.
assert.ok(noteHeight("a".repeat(400), 2000, true) > noteHeight("a".repeat(400), 2000, false));
// The file tree's two layouts, as the app's fileRows: a list of paths, or a tree whose single-child folder chains are one row.
const tree = plain(fileRows(["packages/cli/src/a.ts", "packages/cli/src/daemon/b.ts", "README.md"], ["gone/c.ts"], "tree"));
assert.deepEqual(tree.map(r => `${"  ".repeat(r.depth)}${r.type}:${r.name}`), ["folder:packages/cli/src", "  file:a.ts", "  folder:daemon", "    file:b.ts", "file:README.md", "folder:gone", "  missing:c.ts"]);
assert.deepEqual(tree[0].paths, ["packages/cli/src/a.ts", "packages/cli/src/daemon/b.ts"]);
assert.deepEqual(plain(fileRows(["x/a.ts"], [], "list")), [{ key: "file:x/a.ts", depth: 0, type: "file", name: "x/a.ts", path: "x/a.ts" }]);
// The code widens to its longest line (CJK counts double), unified rows or one split side, and stops at MAX_COLUMNS.
const long = (text) => ({ kind: "row", lines: [{ kind: "+", tokens: [[text]] }] });
assert.equal(contentWidth([long("a".repeat(100))]), Math.ceil(92 + 100 * 7.25 + 16));
assert.equal(contentWidth([long("测".repeat(50))]), contentWidth([long("a".repeat(100))]));
const sides = [{ kind: "pair", lines: [{ left: { tokens: [["a".repeat(10)]] }, right: { tokens: [["a".repeat(100)]] } }, { left: { tokens: [["a"]] } }] }];
assert.deepEqual([contentWidth(sides, "left"), contentWidth(sides, "right"), contentWidth(sides)], [Math.ceil(52 + 10 * 7.25 + 16), Math.ceil(52 + 100 * 7.25 + 16), 108]);
assert.equal(contentWidth([long("a".repeat(5000))]), contentWidth([long("a".repeat(1000))]));
// Split, an added file isn't paired: its rows are "solo", the whole width, measured on their own.
const added = { ...review, files: [file("n.ts", { status: "added", hunks: [{ header: null, rows: [row("+", undefined, 1), row("+", undefined, 2)] }] })] };
const soloItems = plain(buildItems(added, { key: "n", files: ["n.ts"], notes: {}, children: [] }, { ...opts, split: true }));
assert.deepEqual(soloItems.map(item => [item.kind, item.lines?.length ?? 0]), [["file", 0], ["solo", 2]]);
assert.equal(contentWidth([{ kind: "solo", lines: [{ tokens: [["a".repeat(100)]] }] }, ...sides], "solo"), Math.ceil(52 + 100 * 7.25 + 16));
assert.equal(pageLabel("/branch/fix%2Fa", review), "fix/a vs origin/main");
assert.equal(pageLabel("/worktree", review), "Uncommitted changes");
// A range reads as what the Review bar calls it: to push, to pull, or a branch against what it's compared to.
assert.equal(pageLabel("/compare/origin/fix...fix", review), "To push: fix");
assert.equal(pageLabel("/compare/fix...origin/fix", review), "To pull: fix");
assert.equal(pageLabel("/compare/origin/main...other", review), "other vs origin/main");

// main.js: every state's render and every item kind, without a window.
// Elements record their ids and handlers (`id.on_name`), so a test can press one and see what the next render draws.
const drawn = new Set(), handlers = new Map();
const element = (named = null) => {
  let id = named;
  const el = new Proxy(function () {}, { get: (_t, key) => key === "when" ? function (c, f) { if (c) f(this); return this; }
    : key === "id" ? (v) => { id = v; drawn.add(v); return el; }
    : typeof key === "string" && key.startsWith("on_") ? (...args) => { handlers.set(`${id}.${key}`, args.at(-1)); return el; }
    : function () { return this; } });
  return el;
};
const press = (id) => { handlers.get(`${id}.on_click`)({}, cx); drawn.clear(); pane.render(cx); };
const store = new Map(), sharedStore = new Map();
let shownTab = "b", windowActive = true;
const calls = [], bodies = [], routes = [], puts = [], browsed = [];
// A text field's state: its value, and its submit and blur handlers.
const field = { text: "", events: {}, value() { return this.text; }, set_value(v) { this.text = v; }, on(event, h) { this.events[event] = h; return true; } };
const env = {
  View: class {}, div: element, svg: element, image: element, h_flex: element, v_flex: element, h_resizable: element, resizable_panel: element, Scrollbar: { vertical: element },
  Switch: { new: element }, settings: () => ({ zoom: 1 }),
  // Paths build into nothing here; painting one is an element like any other.
  PathBuilder: (() => { const chain = new Proxy({}, { get: () => () => chain }); return { stroke: () => chain, fill: () => chain }; })(),
  window: { paint_path: () => element() }, appWindow: () => ({ platform: "macos", active: windowActive }), exec: (...args) => { browsed.push(args); return Promise.resolve({ code: 0 }); }, Input: { new: () => element() }, InputState: { new: () => field },
  v_virtual_list: (_id, count, sizes, key, render) => { assert.equal(sizes.length, count); render({ start: 0, end: count }).forEach(Boolean); return element(); },
  VirtualListScrollHandle: { new: () => ({ scroll_to_item: (i) => calls.push(["scroll", i]) }) },
  TextView: { markdown: element },
  panes: () => [{ pane: "p9", mod: "review", tab: "b", zoomed: false }], focused: () => ({ tab: "b" }),
  spaces: () => [{ active: true, tabs: [{ id: shownTab, active: true }] }],
  props: () => ({ root: "/repo", page: "/branch/fix", n: 1 }),
  // Shared values every mod sees.
  shared: (key) => sharedStore.get(key) ?? null, setShared: (key, value) => sharedStore.set(key, value),
  run: (name, args) => calls.push([name, args]), theme: () => ({ foreground: "#eeeeee", ansi1: "#ff0000", ansi2: "#00ff00", dim: "#888888" }),
  watchFolder: () => new Promise(() => {}), FILE: 32, ROW: 20, groupFiles, buildItems, pageLabel, contentWidth, fileRows, codeInset, noteWidth,
  // The daemon: rows only for the files asked for, and the first group's with `firstRows`; no run going.
  review: async (_root, route, body) => {
    routes.push(route);
    if (route === "/api/review") bodies.push(body);
    if (route === "/api/review/status") return { running: false };
    const wanted = [...body.rows ?? [], ...body.firstRows ? groupFiles(review.groups[0]) : []];
    return route !== "/api/review" ? {} : { ...review, files: review.files.map(({ hunks, ...f }) => wanted.includes(f.path) ? { ...f, hunks } : { ...f }) };
  },
  // Two agents, one with a catalog; the settings pick pi with a model of its own.
  request: async (_root, method, path, body) => {
    if (method === "PUT") { puts.push(body); return body; }
    return path === "/api/agents"
      ? [{ name: "claude", label: "Claude Code", version: "1", models: [{ id: "sonnet", name: "Sonnet" }] }, { name: "pi", label: "Pi", version: "2", models: [] }]
      : { locale: "zh-CN", llm: { provider: "local-agent", agent: "pi", agentModel: "my/model" } };
  },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
};
const mainScope = load("main.js", env), pane = new mainScope.Mod();
// Every icon the pane names is on disk: a missing svg draws nothing, and its button shows blank.
const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const icons = [
  ...[...mainSource.matchAll(/mods\/\$\{PANE\}\/([a-z/-]+)\.svg/g)].map(m => m[1]),
  ...[...mainSource.matchAll(/\$\{LU\}\/([a-z0-9-]+)\.svg/g)].map(m => `lucide/${m[1]}`),
  ...Object.values(vm.runInContext("CATEGORY", mainScope)).map(([icon]) => `lucide/${icon}`),
  ...vm.runInContext("FILE_ICONS", mainScope).map(([, name]) => `cat/${name}`),
  ...Object.values(vm.runInContext("FOLDER_ICONS", mainScope)).map(name => `cat/${name}`),
  "cat/file", "cat/folder", "lucide/chevron-up", "lucide/chevron-down", "lucide/chevron-right",
  // The fold menu's, named in its rows.
  "lucide/unfold-vertical", "lucide/fold-vertical", "lucide/square-check",
];
for (const icon of icons) assert.ok(fs.existsSync(path.join(__dirname, `${icon}.svg`)), `icon on disk: ${icon}`);
// File and folder icons by @antfu/design's rules, first match winning as there; a folder chain by its last name.
assert.deepEqual(["a/b.vue", "x.test.ts", "package.json", "Makefile"].map(path => vm.runInContext(`fileIcon(${JSON.stringify(path)})`, mainScope)), ["vue", "typescript", "json", "file"]);
assert.deepEqual(["packages/cli/src", "docs"].map(name => vm.runInContext(`folderIcon(${JSON.stringify(name)})`, mainScope)), ["folder-src", "folder"]);
// A category icon is grey until lit, as the app's saturate-0: its hue's luminance.
assert.equal(vm.runInContext('grey("#ff0000")', mainScope), "#363636");
// A run's progress names the files it reads, not their paths.
assert.equal(vm.runInContext('progressText({ kind: "reading", paths: [".git/x/agent/1/a.ts", "b.ts", "c"] })', mainScope), "Reading 3 files: a.ts, …");
assert.equal(vm.runInContext('progressText({ kind: "thinking", step: 2 })', mainScope), "Thinking… (step 2)");
// The 150ms timer is the scroll spy; the others, by period, each pane's in the order they started. A test runs them by hand.
let spy; const every = {};
const cx = { spawn: (f) => f(cx), notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), timer: { every: (ms, f) => { if (ms === 150) spy = f; (every[ms] ??= []).push(f); }, after: (_ms, f) => timers.push(f) } };
// Timers wait until a test runs them.
const timers = [], tick = () => timers.splice(0).forEach(f => f(cx));
(async () => {
  pane.init({}, cx);
  // As the app, which never starts an AI run by itself: analyzing on open is off until turned on.
  assert.equal(pane.autoAnalyze, false);
  // A pane wide enough for the sidebar, and a diff for split, as the pane measures them.
  pane.width = 1200; pane.view = 1000;
  await new Promise(setImmediate);
  // The first read knows no group yet: it asks for the first group's rows, so drawing that group needs no second read.
  assert.deepEqual(plain(bodies.map(b => [b.rows, b.firstRows])), [[[], true]]);
  pane.render(cx);
  await new Promise(setImmediate);
  pane.render(cx);
  assert.equal(bodies.length, 1);
  assert.ok(pane.review.files.every(f => f.hunks));
  // Its pane header, and a tab of its own, say what it reviews.
  assert.deepEqual(plain(sharedStore.get("review.titles")), { b: "fix vs origin/main" });
  assert.equal(sharedStore.get("review.program").inbox, true, "asks for its card in t3-inbox: a pane that loses nothing when it closes");
  assert.equal(sharedStore.get("review.program").name, "Review");
  // The Review bar reads which repository it shows from here; no change, no write: every write redraws every mod.
  assert.equal(sharedStore.get("review.shown").b.root, "/repo");
  const published = sharedStore.get("review.shown"); pane.render(cx);
  assert.equal(sharedStore.get("review.shown"), published);
  // Polling a run asks for no rows and keeps the ones it has.
  pane.load(cx, true);
  await new Promise(setImmediate);
  assert.deepEqual(plain(bodies.at(-1).rows), []);
  assert.ok(pane.review.files.every(f => f.hunks));
  // The pane never zooms itself.
  assert.equal(calls.filter(([name]) => name === "pane.zoom").length, 0);
  for (const state of ["running", "outdated", "none"]) { pane.review.analysis = { state, agent: state !== "none", progress: { kind: "reading", paths: ["a", "b", "c"] } }; pane.version++; pane.render(cx); }
  pane.analyzeError = "boom"; pane.render(cx);
  // As the app's DiffAnalyzeButton, the analysis's state is the button's; running or failed, it opens the status, which
  // shows the run's step or the failure, and once done a Re-run. No words of the analysis stand in the header.
  const states = [{ state: "none", agent: false }, { state: "none", agent: true }, { state: "current", agent: true },
    { state: "outdated", agent: true }, { state: "running", agent: true }, { state: "current", agent: true, error: "boom" }];
  pane.analyzeError = null;
  for (const analysis of states) { pane.review.analysis = analysis; assert.ok(!pane.head().buttons.some(b => b.id === "analyze"), "no Code review button in any state"); }
  assert.equal(pane.head().parts.length, 3);
  pane.review.analysis = { state: "running", agent: true, progress: { kind: "thinking", step: 1 } };
  pane.render(cx); pane.popupClosedAt = 0; pane.togglePopup("status", cx); pane.render(cx);
  assert.ok(drawn.has("review-status-panel") && !drawn.has("rerun"));
  pane.review.analysis = { state: "current", agent: true, error: "boom" }; drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("review-status-panel") && drawn.has("rerun"));
  routes.length = 0; press("rerun");
  assert.ok(pane.popup !== "status" && routes.includes("/api/review/analyze"));
  await new Promise(setImmediate);
  // As the app, running from the click: the daemon answers before the run exists, and the read after it finds none.
  assert.equal(pane.review.analysis.state, "current");
  assert.equal(pane.analyzing(), true);
  // A run seen ends the wait; no run within it, the button says what the daemon does again.
  pane.apply({ ...pane.review, analysis: { state: "running", agent: true } });
  assert.equal(pane.startingUntil, 0);
  pane.startingUntil = Date.now() + 1000; pane.review.analysis = { state: "current", agent: true };
  assert.equal(pane.analyzing(), true);
  pane.startingUntil = Date.now() - 1;
  assert.equal(pane.analyzing(), false);
  // A finished run has no status: the panel isn't shown, even left open.
  pane.popup = "status"; pane.review.analysis = { state: "current", agent: true }; drawn.clear(); pane.render(cx);
  assert.ok(!drawn.has("review-status-panel"));
  pane.key({ keystroke: "escape" }, cx);
  assert.ok(pane.popup !== "status");
  // Its tab and pane header show the word an agent would: a run from the click, then how it ended until the tab is looked at.
  const word = () => sharedStore.get("review.status")?.b ?? null;
  const ended = (analysis) => { pane.review.analysis = { state: "running", agent: true }; pane.report(); pane.review.analysis = { agent: true, ...analysis }; pane.report(); };
  const finished = { state: "current" }, failed = { state: "current", error: "boom" };
  shownTab = "other"; pane.startingUntil = Date.now() + 1000; pane.review.analysis = { state: "current", agent: true }; pane.report();
  assert.equal(word(), "working", "from the click, before the run exists");
  sharedStore.delete("review.status"); pane.report();
  assert.equal(word(), "working", "the Review bar dropped it at its start: a run still going says so again");
  pane.startingUntil = Date.now() - 1; pane.report();
  assert.equal(word(), null, "a start that never came isn't a finished run");
  ended(finished);
  assert.equal(word(), "done");
  const written = sharedStore.get("review.status"); pane.report();
  assert.equal(sharedStore.get("review.status"), written, "no change, no write: every write redraws every mod");
  shownTab = "b"; pane.render(cx);
  assert.equal(word(), null, "looking at the tab reads it");
  shownTab = "other"; ended(failed);
  assert.equal(word(), "blocked");
  ended(finished);
  assert.equal(word(), "done", "the next run's end replaces it");
  shownTab = "b"; ended(failed);
  assert.equal(word(), null, "ended in view, there's no news");
  assert.ok(!pane.head().buttons.some(b => b.id === "analyze"), "a failure does not restore the removed button");
  // Tabs without a review pane drop out; a second pane's word stays, and writing yours doesn't reorder it into a loop.
  const onePane = mainScope.panes;
  mainScope.panes = () => [{ pane: "p9", mod: "review", tab: "b" }, { pane: "p8", mod: "review", tab: "c" }];
  sharedStore.set("review.status", { gone: "working", c: "working" }); pane.report();
  assert.deepEqual(plain(sharedStore.get("review.status")), { c: "working" });
  const kept = sharedStore.get("review.status"); pane.report();
  assert.equal(sharedStore.get("review.status"), kept);
  mainScope.panes = onePane; sharedStore.delete("review.status");
  pane.review.analysis = { state: "current", agent: true }; pane.report();
  // Wide, as the app at `lg`: the groups as tabs by default, and beside the diffs an aside with the files of the group at
  // the list's top; the group with subgroups heads the row. The settings choose the sidebar instead, kept.
  drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("group-tab-g") && !drawn.has("review-sidebar") && drawn.has("review-aside") && drawn.has("group-header"));
  assert.ok(drawn.has("tree-f-a.ts") && !drawn.has("tree-f-c.ts") && !drawn.has("aside-parent"));
  const subAt = pane.itemList.findIndex(item => item.key === "g:k");
  pane.visible = { start: subAt + 1, end: subAt + 3 }; drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("tree-f-c.ts") && !drawn.has("tree-f-a.ts") && drawn.has("aside-parent"), "a subgroup scrolled to shows its files");
  pane.visible = null;
  pane.popupClosedAt = 0; press("settings");
  press("groups-sidebar");
  // The settings credit pulls.review and its author, and the fork and its author, each a link.
  assert.ok(["credit-upstream", "credit-antfu", "credit-fork", "credit-jinjie"].every(id => drawn.has(id)));
  press("credit-fork");
  assert.deepEqual(plain(browsed), [["open", ["https://github.com/JinJieBeWater/pulls.review"]]]);
  assert.equal(sharedStore.get("review.prefs").groupNav, "sidebar");
  press("open-tab");
  assert.equal(sharedStore.get("review.prefs").openIn, "tab");
  press("open-pane");
  assert.equal(sharedStore.get("review.prefs").openIn, "pane");
  pane.closePopup(cx); pane.popupClosedAt = 0; drawn.clear(); pane.render(cx);
  // The sidebar, as the app's: groups only; a group's row shows it; only a group with subgroups has a caret, which hides
  // and shows them.
  assert.ok(drawn.has("review-sidebar") && !drawn.has("group-tab-g") && drawn.has("review-aside") && !drawn.has("side-f-a.ts"));
  assert.ok(drawn.has("side-g-1-k") && drawn.has("side-fold-g"));
  assert.ok(!drawn.has("side-fold-k"), "a subgroup has no caret");
  press("side-fold-g");
  assert.ok(!drawn.has("side-g-1-k") && pane.groupKey === "g");
  press("side-fold-g");
  assert.ok(drawn.has("side-g-1-k"));
  // The scroll spy redraws once what the list shows moved, and not again until it moves.
  let notified = 0; const spyCx = { ...cx, notify: () => notified++ };
  spy(spyCx); notified = 0; spy(spyCx);
  assert.equal(notified, 0);
  pane.visible = { start: subAt + 1, end: subAt + 3 }; spy(spyCx); spy(spyCx);
  assert.equal(notified, 1);
  pane.visible = null;
  const children = pane.review.groups[0].children;
  pane.review.groups[0].children = []; drawn.clear(); pane.render(cx);
  assert.ok(!drawn.has("side-fold-g"), "a group without subgroups has no caret");
  // A group without subgroups heads its aside, not the row.
  assert.ok(!drawn.has("group-header") && drawn.has("aside-header"));
  pane.review.groups[0].children = children; pane.render(cx);
  pane.groupKey = null; press("side-gb-1-k");
  assert.ok(pane.groupKey === "g", "showing a subgroup shows its group");
  // The settings set the files as a list or a tree, kept; the header holds no view toggles.
  assert.ok(!drawn.has("file-list") && !drawn.has("layout"));
  pane.popupClosedAt = 0; press("settings");
  press("files-list");
  assert.equal(pane.fileList, "list");
  assert.equal(sharedStore.get("review.prefs").fileList, "list");
  press("files-tree");
  assert.equal(pane.fileList, "tree");
  pane.closePopup(cx); pane.popupClosedAt = 0;
  pane.select("c.ts", cx);
  assert.equal(pane.current, "c.ts");
  pane.split = true; pane.version++; pane.render(cx);
  pane.key({ keystroke: "j" }, cx); pane.key({ keystroke: "k" }, cx);
  assert.equal(pane.current, "b.png");
  pane.key({ keystroke: "r" }, cx);
  assert.ok(pane.review.files[1].reviewed && pane.collapsed.has("b.png"));
  // Unmarked, it opens again, as the app's.
  pane.key({ keystroke: "r" }, cx);
  assert.ok(!pane.review.files[1].reviewed && !pane.collapsed.has("b.png"));
  pane.key({ keystroke: "r" }, cx);
  // A split side scrolls sideways under the pointer, as far as its longest line goes; the other side stays.
  pane.sideWidth = [0, 1500, 0];
  const wheel = (x, dx) => handlers.get("review-diff-area.on_scroll_wheel")({ delta: { x: dx, y: 0 }, local_position: { x, y: 0 } }, cx);
  wheel(700, -50);
  assert.deepEqual(plain(pane.shift), [0, 50, 0]);
  wheel(700, -5000); wheel(100, -50);
  assert.deepEqual(plain(pane.shift), [0, 1500 - pane.view / 2, 0]);
  wheel(700, 5000);
  assert.equal(pane.shift[1], 0);
  // A full-width added or removed file scrolls under either side, as far as its own longest line.
  pane.render(cx); pane.sideWidth = [0, 0, pane.view + 300];
  wheel(100, -500);
  assert.deepEqual(plain(pane.shift), [0, 0, 300]);
  // Only an overflowing side with rows in view draws its position bar, while it scrolls: as an overlay scrollbar.
  const barItems = (kinds) => { pane.itemList = kinds.map((kind, i) => ({ kind, key: `k${i}`, size: 20 })); pane.visible = { start: 0, end: kinds.length }; };
  const shownItems = pane.itemList, shownVisible = pane.visible;
  const hbars = () => plain(pane.hbars({ muted: "#000000" }).map(b => b.key ?? b.id));
  barItems(["solo"]);
  assert.equal(hbars().length, 1, "the full-width rows' alone");
  barItems(["pair"]);
  assert.deepEqual(hbars(), [], "none on screen: a far-off new file's long line says nothing here");
  pane.sideWidth = [pane.view, pane.view, pane.view + 300]; barItems(["pair"]);
  assert.equal(hbars().length, 2, "a side each, the far-off rows' left out");
  barItems(["pair", "solo"]);
  assert.equal(hbars().length, 3, "all in view: stacked");
  pane.sideWidth = [0, 0, pane.view + 300];
  pane.shift[2] = 0; timers.length = 0; const runs = pane.barsRun;
  wheel(100, -40);
  assert.ok(pane.barsOn && pane.barsRun === runs + 1, "on as it scrolls");
  assert.equal(timers.length, 1);
  wheel(100, -40);
  timers.shift()(cx);
  assert.ok(pane.barsOn, "a later scroll keeps them: the earlier timer is stale");
  timers.shift()(cx);
  assert.ok(!pane.barsOn, "off once it stops");
  pane.shift[2] = 300; wheel(100, -40);
  assert.equal(timers.length, 0, "at the end, nothing moves and nothing shows");
  pane.itemList = shownItems; pane.visible = shownVisible;
  // Analysis settings: opening reads the daemon's agents and settings, a model the catalog lacks shows as its own row;
  // a pick writes the local agent back, resetting the model on an agent switch; the field searches, Enter picks or saves as typed.
  press("settings");
  assert.ok(drawn.has("review-settings-panel"));
  await new Promise(setImmediate);
  assert.equal(field.value(), "");
  drawn.clear(); pane.render(cx);
  // The main page names each setting's value; a setting's list is a page its row opens, so none shows before.
  assert.ok(drawn.has("settings-language") && drawn.has("settings-agent") && drawn.has("settings-model") && !drawn.has("agent-claude") && !drawn.has("model-default"));
  press("settings-model");
  assert.ok(drawn.has("model-custom") && drawn.has("model-list") && drawn.has("settings-back") && !drawn.has("settings-agent"));
  press("settings-back");
  assert.ok(drawn.has("settings-agent") && !drawn.has("model-custom"));
  press("settings-agent");
  press("agent-claude");
  assert.deepEqual(plain(puts.at(-1).llm), { provider: "local-agent", agent: "claude", agentModel: "" });
  assert.equal(puts.at(-1).locale, "zh-CN");
  // A pick comes back to the main page.
  assert.ok(pane.settingsPage === null && drawn.has("settings-model"));
  press("settings-model");
  assert.ok(drawn.has("model-sonnet") && !drawn.has("model-custom"));
  field.set_value("SON"); drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("model-sonnet"));
  field.set_value("xyz"); drawn.clear(); pane.render(cx);
  assert.ok(!drawn.has("model-sonnet"));
  press("model-sonnet");
  assert.equal(puts.at(-1).llm.agentModel, "sonnet");
  assert.equal(field.value(), "");
  assert.equal(pane.settingsPage, null);
  field.set_value("Sonnet"); field.events.submit({}, cx);
  assert.equal(puts.at(-1).llm.agentModel, "sonnet");
  field.set_value(" opus-x "); field.events.submit({}, cx);
  assert.equal(puts.at(-1).llm.agentModel, "opus-x");
  assert.equal(field.value(), "");
  assert.equal(pane.settingsPage, null, "Enter's pick comes back too");
  press("settings-model");
  // ↑ ↓ move through the listed models, wrapping; Enter picks the highlighted one; typing clears the highlight.
  pane.key({ keystroke: "down" }, cx);
  assert.equal(pane.modelIndex, 0);
  pane.key({ keystroke: "up" }, cx);
  assert.equal(pane.modelIndex, 0, "one model: up wraps onto it");
  field.events.submit({}, cx);
  assert.equal(puts.at(-1).llm.agentModel, "sonnet");
  assert.equal(pane.modelIndex, -1);
  pane.key({ keystroke: "down" }, cx); field.set_value("x"); field.events.change({}, cx);
  assert.equal(pane.modelIndex, -1);
  field.set_value("");
  const saved = puts.length;
  field.events.submit({}, cx);
  assert.equal(puts.length, saved, "an empty field saves nothing");
  // Escape goes back a page, leaving the panel open.
  press("settings-model");
  pane.key({ keystroke: "escape" }, cx);
  assert.ok(pane.popup === "settings" && pane.settingsPage === null);
  // The language the analysis writes in, as the app's LanguageMenu: a page of its own, whose pick writes it back with the
  // rest of the settings. Unset, the daemon's default shows as picked.
  press("settings-language");
  assert.ok(drawn.has("language-list") && drawn.has("locale-ja") && !drawn.has("settings-agent"));
  press("locale-ja");
  assert.equal(puts.at(-1).locale, "ja");
  assert.equal(puts.at(-1).llm.agentModel, "sonnet");
  assert.ok(!drawn.has("locale-ja") && drawn.has("settings-agent"));
  pane.shared = { ...pane.shared, locale: undefined, defaultLocale: "fr" };
  assert.equal(pane.locale(), "fr");
  // Shortcuts stay off while the panel takes typing.
  pane.key({ keystroke: "s" }, cx);
  assert.equal(pane.split, true);
  // Auto analyze off: a page with no analysis isn't started; turned back on, it is, once.
  handlers.get("auto-analyze.on_change")(false, cx);
  assert.equal(sharedStore.get("review.prefs").autoAnalyze, false);
  await new Promise(setImmediate);
  review.analysis = { state: "none", agent: true };
  routes.length = 0;
  pane.load(cx); await new Promise(setImmediate);
  assert.ok(!routes.includes("/api/review/analyze"));
  handlers.get("auto-analyze.on_change")(true, cx);
  pane.load(cx); await new Promise(setImmediate);
  assert.equal(routes.filter(r => r === "/api/review/analyze").length, 1);
  // An outdated analysis waits for Re-analyze, even with auto analyze on.
  review.analysis = { state: "outdated", agent: true }; review.head = { sha: "h2" };
  routes.length = 0;
  pane.load(cx); await new Promise(setImmediate);
  assert.ok(!routes.includes("/api/review/analyze"));
  // The settings panel closes on a press outside it or Escape; the gear's own press, which is outside too, doesn't reopen it.
  handlers.get("review-settings-panel.on_mouse_down_out")({}, cx);
  press("settings");
  assert.ok(pane.popup !== "settings" && !drawn.has("review-settings-panel"));
  pane.popupClosedAt = 0; press("settings");
  assert.ok(pane.popup === "settings");
  pane.key({ keystroke: "escape" }, cx);
  assert.ok(pane.popup !== "settings");
  // The settings set unified or split, kept for the next pane; picking the one set changes nothing.
  pane.popupClosedAt = 0; press("settings");
  press("view-split");
  assert.equal(pane.split, true);
  press("view-unified");
  assert.equal(pane.split, false);
  press("view-unified");
  assert.equal(pane.split, false);
  pane.closePopup(cx); pane.popupClosedAt = 0;
  assert.equal(sharedStore.get("review.prefs").split, false);
  // A new pane starts from the shared preferences, not the defaults.
  const second = new (load("main.js", { ...env }).Mod)();
  second.init({}, cx);
  assert.deepEqual([second.split, second.fileList, second.autoAnalyze, second.groupNav], [pane.split, pane.fileList, pane.autoAnalyze, "sidebar"]);
  assert.deepEqual([second.fileList, second.autoAnalyze], ["tree", true]);
  // Opened in a new tab that hasn't the focus yet, a pane takes the review pane's tab nobody claimed, and names it.
  const own = new Map(), third = new (load("main.js", { ...env, focused: () => ({ tab: "a" }),
    panes: () => [{ pane: "p9", mod: "review", tab: "b" }, { pane: "p8", mod: "review", tab: "c" }],
    localStorage: { getItem: (k) => own.get(k) ?? null, setItem: (k, v) => own.set(k, v) } }).Mod)();
  third.init({}, cx); third.render(cx);
  assert.equal(third.tab, "c");
  assert.deepEqual(Object.keys(sharedStore.get("review.titles")).sort(), ["b", "c"]);
  // Responsive: narrower than SPLIT_MIN the diff is unified, the split choice kept; back, split again.
  pane.split = true; pane.view = 600; drawn.clear(); pane.render(cx);
  assert.ok(!pane.itemList.some(item => item.kind === "pair") && pane.split);
  pane.view = 1000; drawn.clear(); pane.render(cx);
  assert.ok(pane.itemList.some(item => item.kind === "pair"));
  // Narrower than WIDE, as the app below `lg`: no sidebar, the groups are tabs over the diff and a group's subgroups
  // sit under its summary; a tab shows its group, a subgroup jumps to it.
  pane.width = 900; drawn.clear(); pane.render(cx);
  assert.ok(!drawn.has("review-sidebar") && drawn.has("group-tab-g") && drawn.has("group-sub-k"));
  // As the app below `lg`: a long run down slides the header and the tabs away, and any scroll up brings them back.
  const scroll = (dy) => { handlers.get("review-diff-area.on_scroll_wheel")({ delta: { x: 0, y: dy }, local_position: { x: 100, y: 0 } }, cx); drawn.clear(); pane.render(cx); };
  scroll(-200);
  assert.ok(drawn.has("review-header") && drawn.has("group-tabs"));
  scroll(-200);
  assert.ok(!drawn.has("review-header") && !drawn.has("group-tabs"));
  scroll(-50); scroll(10);
  assert.ok(drawn.has("review-header") && drawn.has("group-tabs"));
  // Wide, the header stays.
  scroll(-400); pane.width = 1200; drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("review-header"));
  pane.width = 900; scroll(10);
  // The group's header shows only at the list's top, as the app's scrolls away with the diffs.
  pane.visible = { start: 2, end: 5 }; drawn.clear(); pane.render(cx);
  assert.ok(!drawn.has("group-header") && drawn.has("group-tabs"));
  pane.visible = { start: 0, end: 5 }; drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("group-header"));
  // As the app's DiffGroupNav: picking a group shows it, its subgroups under its summary; once the header has scrolled
  // away they stick under the tabs ("subgroups of …"), where its caret folds them. One place at a time.
  pane.groupKey = null; pane.expandedTab = null; press("group-tab-g-button");
  assert.ok(pane.groupKey === "g" && drawn.has("group-sub-k") && !drawn.has("group-subtab-k"));
  // At the top, the caret folds them there; a group newly shown opens them, however it came to be.
  press("group-tab-g-caret");
  assert.ok(!drawn.has("group-sub-k") && !drawn.has("group-subtab-k"));
  press("group-tab-g-caret");
  assert.ok(drawn.has("group-sub-k"));
  const scrolled = () => { pane.visible = { start: 3, end: 6 }; drawn.clear(); pane.render(cx); };
  scrolled();
  assert.ok(drawn.has("group-subtab-k") && !drawn.has("group-sub-k"));
  handlers.get("group-tab-g-caret.on_click")({}, cx); scrolled();
  assert.ok(!drawn.has("group-subtab-k") && pane.groupKey === "g");
  handlers.get("group-tab-g-caret.on_click")({}, cx); scrolled();
  assert.ok(drawn.has("group-subtab-k"));
  const sub = pane.itemList.findIndex(item => item.key === "g:k");
  pane.visible = { start: sub + 3, end: sub + 9 }; calls.length = 0; timers.length = 0;
  press("group-subtab-k-button");
  assert.deepEqual(plain(calls.filter(([name]) => name === "scroll")), [["scroll", sub]]);
  // A narrow header has no AI button either. The commits are the Review bar's.
  pane.width = 500; drawn.clear(); pane.render(cx);
  assert.ok(!drawn.has("analyze") && !drawn.has("commits") && !drawn.has("commit-back"));
  // The bar reads the diff's commits and the page shown; on one commit's page they stay the base's.
  const base = pane.page, baseEntry = () => sharedStore.get("review.shown").b;
  assert.deepEqual(plain(baseEntry()), { root: "/repo", page: base, base, commits: [{ sha: "c1", subject: "one", time: null }, { sha: "c2", subject: "two", time: null }] });
  const opened = [];
  pane.open = (page) => { opened.push(page); pane.page = page; };
  sharedStore.set("review", { tab: "b", root: "/repo", page: "/commit/c2", base, n: pane.handled + 1 });
  drawn.clear(); pane.render(cx);
  assert.deepEqual([opened, pane.base, baseEntry().page, baseEntry().base, baseEntry().commits.length], [["/commit/c2"], base, "/commit/c2", base, 2]);
  delete pane.open; pane.page = base;
  // One popup at a time: a press on another's button closes the open one (a press outside it) and opens its own at once;
  // a press on the open one's own button only closes it.
  pane.popupClosedAt = 0; press("settings");
  handlers.get("review-settings-panel.on_mouse_down_out")({}, cx); press("fold-menu");
  assert.equal(pane.popup, "fold");
  handlers.get("review-fold-menu.on_mouse_down_out")({}, cx); press("fold-menu");
  assert.equal(pane.popup, null);
  // The pane's own header names the diff, not the repo; this one counts reviewed files beside a donut.
  pane.render(cx);
  assert.equal(sharedStore.get("review.titles").b, "fix vs origin/main");
  assert.equal(pane.head().parts.find(p => p.donut !== undefined).text, `${pane.review.files.filter(f => f.reviewed).length}/${pane.review.files.length}`);
  assert.ok(!pane.head().buttons.some(b => b.id === "analyze"));
  // Wide again, the sidebar instead of the tabs.
  pane.width = 1200; drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("review-sidebar") && !drawn.has("group-tab-g") && !drawn.has("group-sub-k"));
  // One press on a file's header acts at once, by where it lands: the reviewed box at its start, the whole file and the
  // fold at its end, a fold anywhere else; and the file becomes the current one.
  pane.view = 1000; pane.render(cx);
  const header = (x) => { handlers.get("review-diff-area.on_mouse_down")({ local_position: { x, y: 0 } }, cx); handlers.get("null.on_item_click")("f:c.ts", cx); };
  const c = () => pane.review.files.find(f => f.path === "c.ts");
  const reviewed = c().reviewed;
  header(20);
  assert.ok(c().reviewed !== reviewed && pane.current === "c.ts");
  header(pane.view - 50);
  assert.ok(pane.full.has("c.ts"));
  await new Promise(setImmediate);
  const folded = pane.collapsed.has("c.ts");
  header(pane.view - 20);
  assert.equal(pane.collapsed.has("c.ts"), !folded);
  header(300);
  assert.equal(pane.collapsed.has("c.ts"), folded);
  // Scrolled into a file, its header sticks at the top, as the app's; a press there is the header's, not the row's under it,
  // and folding the file from there brings its header back to the top.
  pane.collapsed.delete("c.ts"); pane.version++; pane.render(cx);
  const headAt = pane.itemList.findIndex(item => item.key === "f:c.ts"), rowAt = pane.itemList.findIndex(item => item.key.startsWith("r:c.ts"));
  pane.visible = { start: headAt, end: headAt + 2 }; drawn.clear(); pane.render(cx);
  assert.ok(!drawn.has("sticky-file"), "a header in view doesn't stick");
  pane.visible = { start: rowAt, end: rowAt + 2 }; drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("sticky-file"));
  pane.current = null; calls.length = 0;
  handlers.get("review-diff-area.on_mouse_down")({ local_position: { x: 300, y: 10 } }, cx);
  handlers.get("null.on_item_click")(pane.itemList[rowAt].key, cx);
  assert.equal(pane.current, null);
  handlers.get("sticky-file.on_click")({}, cx);
  assert.ok(pane.collapsed.has("c.ts") && pane.current === "c.ts");
  assert.deepEqual(plain(calls.filter(([name]) => name === "scroll")), [["scroll", headAt]]);
  pane.collapsed.delete("c.ts"); pane.version++; pane.render(cx);
  // Unified, code scrolls sideways by the wheel too, the headers staying put.
  pane.split = false; pane.version++; pane.render(cx); pane.shift = [0, 0, 0]; pane.sideWidth = [0, 0, pane.view + 200];
  handlers.get("review-diff-area.on_scroll_wheel")({ delta: { x: -500, y: 0 }, local_position: { x: 100, y: 0 } }, cx);
  assert.deepEqual(plain(pane.shift), [0, 0, 200]);
  // Picking a file brings its header exactly to the top. Below the view: first the first item a view's height past it,
  // bottom-aligned, which carries it over the top; once that frame is drawn, it, which then lands at the top.
  const items = pane.itemList, last = items.filter(item => item.kind === "file").at(-1), at = items.indexOf(last), path = last.file.path;
  const scrolls = () => plain(calls.filter(([name]) => name === "scroll"));
  assert.ok(at >= 2);
  pane.listHeight = items[at].size + items[at + 1].size; pane.visible = { start: 0, end: 2 }; calls.length = 0; timers.length = 0;
  pane.select(path, cx);
  assert.deepEqual(scrolls(), [["scroll", at + 2]]);
  tick();
  assert.deepEqual(scrolls(), [["scroll", at + 2]], "no second scroll before the first has drawn");
  pane.frames++; tick();
  assert.deepEqual(scrolls(), [["scroll", at + 2], ["scroll", at]]);
  // A newer pick drops an older one's settling.
  calls.length = 0;
  pane.select(path, cx); pane.select(items.find(item => item.kind === "file").file.path, cx);
  pane.frames++; tick();
  assert.equal(scrolls().filter(([, i]) => i === at).length, 0);
  // Another group shown, the range last drawn was the old list's: the pick goes the two-step way.
  pane.visible = { start: at + 1, end: at + 5 }; pane.version++; calls.length = 0; timers.length = 0;
  pane.select(path, cx);
  assert.ok(timers.length === 1 && scrolls()[0][1] !== at);
  pane.render(cx);
  // At or above the top, one scroll: the near edge is the top.
  for (const start of [at, at + 1]) {
    pane.visible = { start, end: start + 5 }; calls.length = 0; timers.length = 0;
    pane.select(path, cx);
    assert.deepEqual(scrolls(), [["scroll", at]]);
    assert.equal(timers.length, 0);
  }
  // A blank after the list lets the last header reach the top: a view's height less what follows that header.
  const after = items.slice(at).reduce((n, item) => n + item.size, 0);
  pane.listHeight = after + 100;
  assert.equal(pane.trailing(), 100);
  pane.listHeight = after - 1;
  assert.equal(pane.trailing(), 0);
  // A folder in the aside's tree doesn't fold, as the app's: its box marks its files.
  pane.width = 1200; pane.fileList = "tree";
  pane.review.files.push(file("x/y/z.ts"));
  pane.review.groups[0].files.push("x/y/z.ts");
  pane.select("a.ts", cx); pane.version++; pane.visible = null; drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("tree-d-folder:x/y/") && drawn.has("tree-f-x/y/z.ts") && !handlers.has("tree-d-folder:x/y/.on_click"));
  press("tree-dcheck-folder:x/y/");
  assert.ok(pane.review.files.find(f => f.path === "x/y/z.ts").reviewed);
  // The fold menu, as the app's DiffCollapseMenu: every file of the diff at once, and the file at the view's top back there.
  pane.width = 900; pane.review.files[0].test = true; drawn.clear(); pane.render(cx);
  // The stub list draws from the top on every render: the range a test sets goes in after the menu opens.
  const fold = (id, at = null) => {
    pane.popupClosedAt = 0; press("fold-menu"); assert.ok(drawn.has("review-fold-menu"));
    if (at !== null) pane.visible = { start: at, end: at + 2 };
    press(`fold-${id}`); assert.ok(!drawn.has("review-fold-menu"));
  };
  const shut = () => pane.review.files.filter(f => pane.collapsed.has(f.path)).map(f => f.path).sort();
  fold("expand-all");
  assert.deepEqual(shut(), []);
  const cRow = pane.itemList.findIndex(item => item.key.startsWith("r:c.ts"));
  calls.length = 0; timers.length = 0;
  fold("collapse-all", cRow);
  assert.deepEqual(shut(), pane.review.files.map(f => f.path).sort());
  pane.frames++; tick();
  assert.equal(scrolls().at(-1)[1], pane.itemList.findIndex(item => item.key === "f:c.ts"));
  fold("expand-all"); fold("collapse-reviewed");
  assert.deepEqual(shut(), pane.review.files.filter(f => f.reviewed).map(f => f.path).sort());
  fold("expand-all"); fold("collapse-tests");
  assert.deepEqual(shut(), ["a.ts"]);
  // Narrow, the tabs keep to one row that scrolls sideways.
  assert.ok(drawn.has("group-tab-row"));
  pane.width = 500; pane.render(cx);
  // Data flow. A read asks rows only for the group's files without them.
  const daemon = mainScope.review, settle = () => new Promise(setImmediate);
  await settle(); await settle(); // The folder mark above, and the read after it.
  const shownFiles = groupFiles(pane.group()), first = shownFiles[0], target = () => pane.review.files.find(f => f.path === first);
  for (const f of pane.review.files) if (shownFiles.includes(f.path)) f.hunks ??= [];
  delete target().hunks;
  pane.load(cx); await settle();
  assert.deepEqual(plain(bodies.at(-1).rows), [first]);
  // A read that says what the one shown does changes nothing: the list isn't rebuilt, and its files stay the ones marks change.
  const shownReview = pane.review, shownVersion = pane.version;
  pane.load(cx, true); await settle();
  assert.ok(pane.review === shownReview && pane.version === shownVersion);
  // While a run goes, the pane asks how it's going, one call at a time, not for the diff; once it ended, the diff is read.
  let status = { running: true, progress: { kind: "thinking", step: 3 } };
  mainScope.review = (root, route, body) => route === "/api/review/status" ? (routes.push(route), Promise.resolve(status)) : daemon(root, route, body);
  pane.review.analysis = { state: "running", agent: true }; routes.length = 0;
  every[1500][0](cx); every[1500][0](cx); await settle();
  assert.deepEqual(plain(routes), ["/api/review/status"]);
  assert.equal(pane.review.analysis.progress.step, 3);
  status = { running: false }; routes.length = 0;
  every[1500][0](cx); await settle();
  assert.deepEqual(plain(routes), ["/api/review/status", "/api/review"]);
  // A daemon without the route reads the diff, as before.
  mainScope.review = (root, route, body) => route === "/api/review/status" ? Promise.reject(new Error("Cannot find any route matching")) : daemon(root, route, body);
  pane.review.analysis = { state: "running", agent: true }; routes.length = 0;
  every[1500][0](cx); await settle();
  assert.deepEqual(plain(routes), ["/api/review"]);
  mainScope.review = daemon;
  // Unseen - another tab shown, or the window inactive - the slow timer doesn't read; seen again, one read follows.
  const slow = every[15000][0], wake = every[1000][0];
  routes.length = 0; shownTab = "other";
  slow(cx); slow(cx); wake(cx); await settle();
  shownTab = "b"; windowActive = false; wake(cx); await settle();
  assert.deepEqual(plain(routes), []);
  windowActive = true; wake(cx); await settle(); wake(cx); await settle();
  assert.deepEqual(plain(routes), ["/api/review"]);
  slow(cx); await settle();
  assert.equal(routes.length, 2, "seen, the slow timer reads");
  // A read from before a reviewed mark landed doesn't undo it on screen.
  let release;
  mainScope.review = (root, route, body) => route === "/api/review/reviewed" ? new Promise(r => { release = r; }) : daemon(root, route, body);
  const was = target().reviewed;
  pane.setReviewed(target(), !was, cx);
  pane.load(cx); await settle();
  assert.equal(target().reviewed, !was);
  release(); await settle(); await settle();
  // A start the daemon refuses ends the wait and says why.
  mainScope.review = (root, route, body) => route === "/api/review/analyze" ? Promise.reject(new Error("no agent")) : daemon(root, route, body);
  pane.analyze(cx, false); await settle();
  assert.ok(pane.startingUntil === 0 && pane.analyzeError === "no agent");
  // Another diff opened meanwhile takes neither the old one's whole file nor its analysis failure.
  let reply;
  mainScope.review = (root, route, body) => route === "/api/review/file" ? new Promise(r => { reply = r; }) : daemon(root, route, body);
  const home = pane.page;
  pane.full.delete(first); pane.toggleFull(target(), cx); pane.analyzeError = "boom";
  // As the app's button, disabled while it loads: another press doesn't cancel it.
  pane.toggleFull(target(), cx);
  assert.ok(pane.full.has(first));
  pane.startingUntil = Date.now() + 1000;
  // The whole file comes back after the other diff has loaded.
  pane.open("/commit/c1", cx); await settle();
  reply({ rows: [] }); await settle();
  assert.ok(!pane.full.has(first) && pane.analyzeError === null && pane.startingUntil === 0);
  // Leaving a page mid-run isn't that run finishing.
  shownTab = "other"; pane.apply({ ...pane.review, analysis: { state: "running", agent: true } }); pane.report();
  assert.equal(word(), "working");
  pane.open("/commit/c2", cx); pane.report();
  assert.equal(word(), null);
  await settle(); shownTab = "b";
  mainScope.review = daemon; pane.open(home, cx); await settle();
  // Back to a page seen: the same files have the same shas, and its rows went with it, so they're asked for again.
  const wait = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
  const drawAll = async () => { for (let i = 0; i < 3; i++) { drawn.clear(); pane.render(cx); await wait(); } };
  const there = pane.page;
  await drawAll();
  pane.open("/commit/c1", cx); await wait(); await drawAll();
  pane.open(there, cx); await wait(); await drawAll();
  const inGroup = groupFiles(pane.group()).map(path => pane.review.files.find(f => f.path === path)).filter(Boolean);
  assert.ok(inGroup.length > 0 && inGroup.every(f => f.hunks), "rows on coming back");
  // A read that never answers doesn't freeze the pane: a read of the same page waits for it, and after a while the pane
  // says it didn't answer, with Retry. Its late answer still counts.
  let answer; const asked = [];
  mainScope.review = (root, route, body) => route === "/api/review" ? (asked.push(body.page), new Promise(r => { answer = r; })) : daemon(root, route, body);
  timers.length = 0;
  pane.load(cx); pane.load(cx);
  assert.equal(asked.length, 1);
  tick(); drawn.clear(); pane.render(cx);
  assert.ok(pane.error && drawn.has("retry") && !pane.loading);
  const late = await daemon("/repo", "/api/review", { page: there, rows: [] });
  answer({ ...late, title: "late" }); await wait();
  assert.ok(pane.review.title === "late" && !pane.error);
  // A read of another page starts at once, and the old page's answer, coming after its own, is dropped.
  const answers = new Map();
  mainScope.review = (root, route, body) => route === "/api/review" ? new Promise(r => answers.set(body.page, r)) : daemon(root, route, body);
  pane.open("/commit/c1", cx);
  answers.get("/commit/c1")({ ...late, title: "new" }); await wait();
  answer({ ...late, title: "old" }); await wait();
  assert.equal(pane.review.title, "new");
  mainScope.review = daemon;
  // Reopened on one commit's page, which lists only itself: the bar's list is read from its base, once.
  const reopened = new Map([["tab", "b"], ["root", "/repo"], ["page", "/commit/c2"], ["base", "/branch/fix"], ["handled", "99"]]);
  const baseReads = [];
  const fresh = new (load("main.js", { ...env, localStorage: { getItem: (k) => reopened.get(k) ?? null, setItem: (k, v) => reopened.set(k, v) },
    review: async (_root, _route, body) => {
      if (body.page === "/branch/fix") baseReads.push(body.rows);
      return { ...review, files: [], commits: body.page === "/branch/fix" ? review.commits : [review.commits[1]] };
    } }).Mod)();
  fresh.init({}, cx); await wait(); fresh.render(cx); await wait(); fresh.load(cx); await wait(); fresh.render(cx);
  assert.equal(sharedStore.get("review.shown").b.commits.length, 2);
  assert.deepEqual(plain(baseReads), [[]], "once, and without rows");
  // A daemon too old for `firstRows` ignores it: drawing the first group asks for its rows, once.
  const oldReads = [];
  const older = new (load("main.js", { ...env, localStorage: { getItem: (k) => k === "handled" ? "99" : null, setItem() {} }, review: async (_root, _route, body) => {
    oldReads.push(body.rows);
    return { ...review, files: review.files.map(({ hunks, ...f }) => body.rows.includes(f.path) ? { ...f, hunks } : { ...f }) };
  } }).Mod)();
  older.init({}, cx); await wait(); older.render(cx); await wait(); older.render(cx); await wait();
  assert.deepEqual(plain(oldReads), [[], ["a.ts", "b.png", "c.ts"]]);
  // A watched change reads the diff only if it touches it: Git's HEAD or refs, or a file Git doesn't ignore (macOS reports
  // those too). The next batch waits a second, so at most one change read a second.
  let batch, watches = 0; const checked = [], watchReads = [];
  const watcher = new (load("main.js", { ...env, localStorage: { getItem: (k) => k === "handled" ? "99" : null, setItem() {} },
    watchFolder: () => { watches++; return new Promise(r => { batch = r; }); },
    exec: async (_cmd, args) => {
      const paths = args.slice(3), ignored = paths.filter(p => p.includes("node_modules"));
      checked.push(paths);
      return { code: ignored.length ? 0 : 1, stdout: ignored.join("\n") };
    },
    review: async (_root, route) => { watchReads.push(route); return { ...review, files: [] }; } }).Mod)();
  watcher.init({}, cx); await wait();
  const changed = async (paths) => {
    watchReads.length = 0; timers.length = 0; const before = watches;
    batch(paths); await wait();
    const reads = watchReads.length, waited = watches === before;
    tick(); await wait();
    assert.ok(waited && watches === before + 1, "the next batch a second later");
    return reads;
  };
  assert.equal(await changed(["/repo/.git/objects/ab/cd", "/repo/.git/index"]), 0);
  assert.deepEqual(checked, [], "Git's own files are judged without asking it");
  assert.equal(await changed(["/repo/node_modules/x"]), 0);
  assert.equal(await changed(["/repo/node_modules/x", "/repo/a.ts"]), 1);
  assert.equal(await changed(["/repo/.git/refs/heads/fix"]), 1);
  // Switching page keeps the old one on screen, dimmed and inert, until the new one's read replaces it, which starts at
  // its top. Meanwhile the read asks for the new page's first group, and the title and header don't read the old review.
  let next;
  mainScope.review = (root, route, body) => route === "/api/review" ? (bodies.push(body), new Promise(r => { next = r; })) : daemon(root, route, body);
  shownTab = "b"; pane.width = 1200; await drawAll();
  const old = pane.review, marked = pane.marks, split = pane.split;
  pane.current = old.files[0].path; pane.full.clear(); calls.length = 0;
  pane.open("/commit/c2", cx);
  assert.ok(pane.review === old && pane.switching);
  assert.deepEqual(plain(bodies.at(-1)).rows, []);
  assert.equal(bodies.at(-1).firstRows, true);
  drawn.clear(); pane.render(cx);
  assert.ok(drawn.has("review-diff-area") && drawn.has("settings") && !drawn.has("analyze"), "the old list, without its counts and analysis");
  assert.equal(sharedStore.get("review.titles").b, "c2");
  pane.setReviewed(old.files[0], !old.files[0].reviewed, cx); pane.toggleFull(old.files[0], cx); pane.headerPress(old.files[0], 0, cx);
  pane.key({ keystroke: "s" }, cx); pane.key({ keystroke: "j" }, cx);
  assert.ok(pane.marks === marked && !pane.full.size && pane.split === split && pane.current === old.files[0].path, "inert");
  next({ ...review, title: "two" }); await wait();
  assert.ok(!pane.switching && pane.review.title === "two" && pane.current === null);
  assert.deepEqual(plain(calls.filter(([name]) => name === "scroll")), [["scroll", 0]]);
  // A failed read clears the old review rather than show it under the new page's title.
  mainScope.review = (root, route, body) => route === "/api/review" ? Promise.reject(new Error("gone")) : daemon(root, route, body);
  pane.open("/commit/c1", cx); await wait();
  assert.ok(pane.review === null && pane.error === "gone" && !pane.switching);
  mainScope.review = daemon;
  // The shared side panel follows each tab's selected diff without creating or focusing panes.
  let sidebarTab = "b";
  const panelTree = { id: "panel", hidden: false, children: [{ id: "panel-body", active: "review" }] };
  sharedStore.set("review.sidebar", {
    b: { tab: "b", root: "/repo", page: "/branch/fix", n: 1000 },
    c: { tab: "c", root: "/other", page: "/worktree", n: 2000 },
  });
  const sidebarStore = new Map(), sidebarScope = load("main.js", { ...env,
    props: () => ({ sidebar: true }), focused: () => ({ tab: sidebarTab }),
    panes: () => [], layout: () => panelTree,
    localStorage: { getItem: k => sidebarStore.get(k) ?? null, setItem: (k, v) => sidebarStore.set(k, v) },
  });
  const sidebar = new sidebarScope.Mod();
  sidebar.init({}, cx); await wait(); drawn.clear(); sidebar.render(cx); await wait();
  assert.equal(sidebar.onScreen(), true);
  assert.equal(sidebar.root, "/repo");
  assert.equal(sharedStore.get("review.sidebarShown").b.root, "/repo");
  assert.ok(!sidebar.head().buttons.some(b => b.id === "analyze"));
  panelTree.hidden = true; assert.equal(sidebar.onScreen(), false);
  panelTree.hidden = false; panelTree.children[0].active = "linear"; assert.equal(sidebar.onScreen(), false);
  panelTree.children[0].active = "review";
  sidebarTab = "c"; sidebar.render(cx); await wait(); sidebar.render(cx);
  assert.deepEqual([sidebar.tab, sidebar.root, sidebar.page], ["c", "/other", "/worktree"]);
  sidebarTab = "b"; sidebar.render(cx); await wait(); sidebar.render(cx);
  assert.deepEqual([sidebar.tab, sidebar.root, sidebar.page], ["b", "/repo", "/branch/fix"], "switching back restores an older selection");
  assert.equal(sharedStore.get("review.sidebarShown").c.root, "/other");
  sidebar.popup = "settings"; drawn.clear(); sidebar.render(cx);
  assert.ok(!drawn.has("open-pane") && !drawn.has("open-tab"), "sidebar settings offer no pane or tab destination");
  sidebarTab = "no-selection"; drawn.clear(); sidebar.render(cx);
  assert.ok(!drawn.has("review-diff-area"), "a tab without a selection never shows another tab's diff");
  console.log("ok: pairs, items, notes and heights; the pane renders every analysis state, unified and split; rows only for the group shown, kept across polls; groups as tabs or a sidebar, the aside's files following the list, as a tree or a list; the fold menu; analysis settings and auto analyze; reads that don't undo marks or carry over to another diff; no zoom.");
})();
