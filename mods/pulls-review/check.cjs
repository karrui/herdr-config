// Modified for herdr-config: verify chat folders and added/removed line badges.
// node mods/pulls-review/check.cjs: bar.js, open.js and main.js run on inert elements, as Herdr would load them, without a window.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

function element(kind = "div", source) {
  const node = { kind, source, items: [], handlers: {}, style: {}, hoverStyle: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "child" || key === "trigger") node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key === "on_mouse_down") node.handlers[`${key}:${args[0]}`] = args[1];
      else if (key.startsWith("on_")) node.handlers[key] = args[0];
      else if (key === "id") node.key = args[0];
      else if (key === "hover") { const hovered = element(); args[0](hovered); node.hoverStyle = hovered.style; }
      else node.style[key] = args.length === 1 ? args[0] : args;
      return proxy;
    };
  } });
  return proxy;
}
const find = (node, id) => !node || typeof node !== "object" ? null : node.key === id ? node : node.items.map(c => find(c, id)).find(Boolean) ?? null;
const strings = (node) => typeof node === "string" ? [node] : node && typeof node === "object" ? node.items.flatMap(strings) : [];
const walk = (node) => node && typeof node === "object" ? [node, ...node.items.flatMap(walk)] : [];
const keys = (node) => node.items.map(n => typeof n.key === "string" ? n.key : n.kind);
function fire(node, event, ...args) {
  assert.ok(node, `missing event target: ${event}`);
  assert.equal(typeof node.handlers[event], "function", event);
  return node.handlers[event](...args);
}
const plain = (value) => JSON.parse(JSON.stringify(value));

const zoom = 1.1, calls = [], overlays = [], closed = [], notes = [], launched = [], state = {}, shown = { pane: "p1", tab: "b" };
const theme = new Proxy({ foreground: "#f4f4f6", dim: "#77777f", border: "#2a2a30", hover: "#202024", ansi1: "#e06c75", ansi2: "#98c379", ansi3: "#c8a84b", ansi4: "#5f8fe0", ansi9: "#f08c95", ansi10: "#b5e09a", ansi11: "#e8cf7a", ansi12: "#8fb4f2" }, { get: (t, k) => t[k] ?? "#a9a9b4" });
const env = {
  View: class {}, div: () => element(), h_flex: () => element("h"), v_flex: () => element("v"),
  svg: (source) => element("svg", source), image: (source) => element("image", source), Input: { new: () => element("input") }, HoverCard: { new: (id) => element("hovercard").id(id) }, Popup: { new: (id) => element("popup").id(id) },
  InputState: { new: () => ({ on() {}, value: () => "", focus() {} }) },
  theme: () => theme, settings: () => ({ zoom }), keys: () => [], window: () => ({ platform: "macos", active: true }),
  spaces: () => [{ id: "s", active: true, folder: "/space", tabs: [{ id: "b" }] }], panes: () => [{ pane: "p1", tab: "b", cwd: "/repo/src" }],
  focused: () => shown, terminals: () => [], exec: async () => ({ code: 1, stdout: "" }), hc: async () => ({ code: 1 }), watchFolder: () => new Promise(() => {}),
  layout: () => ({ id: "root", children: [{ id: "panel", hidden: false, children: [{ id: "panel-body", active: "files", children: [{ id: "review" }] }] }] }),
  shared: (key) => state[key], setShared: (key, value) => { state[key] = value; },
  run: (name, args) => calls.push([name, plain(args)]), notify: (n) => notes.push(n),
  openOverlay: (spec) => overlays.push(spec), closeOverlay: (id) => closed.push(id),
  appHome: () => "/app", home: () => "/Users/me", readTextFile: async () => '{ "open": "herdr" }',
};
const source = ["details.js", "tip.js", "bar.js", "open.js", "main.js"].map(file => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n")
  .replace(/^import [^;]*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class").replace(/^export /gm, "");
// Timers fire at once: a card that waits 150ms is up by the next render.
const cx = { notify() {}, stop_propagation() {}, spawn: (f) => f(cx), timer: { every() {}, after: (_ms, f) => (f(cx), { cancel() {} }) } };
// `setup` gets the module's scope before init, to stand in for git; by default it records what open.js's launch gets.
const record = (scope) => { scope.launch = (input) => { launched.push(plain(input)); }; };
const load = (props = {}, setup = record) => {
  const scope = vm.createContext({ ...env, props: () => props });
  vm.runInContext(source, scope, { filename: "pulls-review" });
  setup?.(scope);
  const mod = new scope.Mod();
  mod.init?.(props, cx);
  return { mod, scope };
};

(async () => {
  // The counts: a line per file (renamed and untracked too), the arrows from the branch headers, and the commits the
  // branch adds to the default branch, resolved as the CLI does.
  const { mod: bar, scope } = load({ block: "review" });
  assert.equal(find(bar.render(), "pulls-review"), null, "no bar before git is read");
  let status = ["# branch.oid 1a2b", "# branch.head feat", "# branch.upstream origin/feat", "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 1a2b 1a2b src/a.js", "2 R. N... 100644 100644 100644 1a2b 1a2b R100 new.js\told.js", "? notes.md", ""].join("\n");
  const refs = { "main...HEAD": "0\t4\n" }; // No origin/HEAD, no origin/main: the local main.
  scope.exec = async (_command, args) => _command === "sh" ? { code: 0, stdout: "5\t2\tsrc/a.js\n-\t-\timage.png\n" }
    : args.includes("--show-toplevel") ? { code: 0, stdout: "/repo\n" }
    : args.includes("symbolic-ref") ? { code: 1, stdout: "" }
    : args.includes("rev-list") ? (refs[args.at(-1)] ? { code: 0, stdout: refs[args.at(-1)] } : { code: 128, stdout: "" })
    : args.includes("--numstat") ? { code: 0, stdout: args.includes("HEAD") ? "5\t2\tsrc/a.js\n-\t-\timage.png\n" : "12\t4\tsrc/a.js\n" }
    : (assert.ok(args.includes("--untracked-files=all"), "a new folder counts its files, as the page it opens"), { code: 0, stdout: status });
  const review = await scope.readReview("/repo/src");
  const show = r => bar.reviews.set(JSON.stringify(scope.reviewLocation()), r);
  assert.deepEqual(plain(review), { root: "/repo", branch: "feat", upstream: "origin/feat", base: "main", baseRef: "main", changed: 3, ahead: 2, behind: 1, unmerged: 4, newer: 0, gone: false, worktreeStats: { add: 5, del: 2 }, branchStats: { add: 12, del: 4 } });
  show(review);
  const drawn = bar.render();
  assert.deepEqual(strings(find(drawn, "review-open")), ["4", "ahead of main", "+12", "−4"], "the branch's count says what it is against");
  assert.deepEqual(strings(find(drawn, "review-changes")), ["3", "uncommitted", "+5", "−2"]);
  // One outline, its parts ruled apart: a control group on its own in any bar.
  assert.ok(find(drawn, "pulls-review").style.border);
  assert.deepEqual(keys(find(drawn, "pulls-review")), ["tip-review-pick", "div", "tip-review-open", "div", "tip-review-changes", "div", "tip-review-ahead", "div", "tip-review-behind"]);
  assert.equal(strings(find(drawn, "tip-review-ahead").style.content).length, 0, "its card waits for the hover");
  assert.ok("rounded_r" in find(drawn, "review-behind").style, "the last part's fill follows the outline's corner");
  assert.equal(find(drawn, "review-open").style.accessibility_label, "Review the branch: 4 commits on feat, not on main");
  for (const n of walk(drawn)) if (n.hoverStyle.text_color) assert.ok(!walk(n).some(c => c.kind === "svg"), `${n.key}: a hover style can't brighten its icon`);
  // The logo, in its own colors and on disk: a missing file draws nothing, and the button shows blank.
  const logo = walk(find(drawn, "review-pick")).find(n => n.kind === "image");
  assert.equal(logo.source, "mods/pulls-review/logo.svg");
  assert.ok(fs.existsSync(path.join(__dirname, "logo.svg")));
  fire(find(drawn, "review-pick"), "on_hover", true, cx);
  assert.deepEqual(strings(find(bar.render(), "tip-review-pick").style.content), ["Change what to review"], "its card shows on hover");
  fire(find(drawn, "review-pick"), "on_hover", false, cx);
  // Each count in its own color, so what there is to review reads at a glance; hovered, its bright twin.
  const countColor = id => find(bar.render(), id).items[0].style.text_color;
  assert.deepEqual(["review-open", "review-changes", "review-ahead", "review-behind"].map(countColor), [theme.ansi4, theme.ansi3, theme.ansi2, theme.ansi1]);
  fire(find(drawn, "review-open"), "on_hover", true, cx);
  assert.equal(countColor("review-open"), theme.ansi12, "hovered, the count takes its bright twin");
  fire(find(drawn, "review-changes"), "on_hover", true, cx);
  fire(find(drawn, "review-open"), "on_hover", false, cx);
  assert.equal(countColor("review-changes"), theme.ansi11, "the old segment's late leave doesn't clear the new one");
  assert.equal(countColor("review-open"), theme.ansi4);
  fire(find(drawn, "review-changes"), "on_hover", false, cx);
  assert.equal(countColor("review-changes"), theme.ansi3);
  assert.equal(find(drawn, "review-ahead").style.accessibility_label, "Review 2 commits to push: on feat, not on origin/feat", "the label says what a count compares");
  assert.equal(find(drawn, "review-behind").style.accessibility_label, "Review 1 commit to pull: on origin/feat as of your last fetch, not on feat");
  assert.equal(walk(drawn).filter(n => "tooltip" in n.style).length, 0, "the shell's tooltip isn't Herdr T3's");
  fire(find(drawn, "review-ahead"), "on_hover", true, cx);
  assert.deepEqual(strings(find(bar.render(), "tip-review-ahead").style.content), ["Review 2 commits to push"], "the label names what it does; what it compares stays in the accessibility label");
  fire(find(drawn, "review-ahead"), "on_hover", false, cx);
  Object.assign(shown, { pane: "p9", cwd: "/other" });
  assert.equal(find(bar.render(), "pulls-review"), null, "another location never shows this one's counts, even before its own read");
  Object.assign(shown, { pane: "p1", cwd: undefined });
  assert.ok(find(bar.render(), "review-open"), "coming back shows the last read at once");
  // The review pane focused, in a tab of its own: the repository it shows, not the space's folder.
  const allPanes = scope.panes;
  scope.panes = () => [{ pane: "p7", mod: "review", tab: "r", cwd: null }];
  state["review.shown"] = { r: { root: "/repo" } };
  Object.assign(shown, { pane: "p7", tab: "r" });
  assert.deepEqual(plain(scope.reviewLocation()), { cwd: "/repo", on: null });
  scope.panes = allPanes; delete state["review.shown"];
  Object.assign(shown, { pane: "p1", tab: "b" });
  scope.panes = () => [{ pane: "p1", mod: "chat", tab: "b", cwd: null }];
  scope.terminals = () => [
    { state: "live", labels: { "herdr.chat": "other" }, cwd: "/wrong" },
    { state: "exited", labels: { "herdr.chat": "p1" }, cwd: "/stale" },
    { state: "live", labels: { "herdr.chat": "p1" }, cwd: "/repo", foreground: { cwd: "/repo/worktree" } },
  ];
  assert.deepEqual(plain(scope.reviewLocation()), { cwd: "/repo/worktree", on: null }, "chat reviews use the parked agent's live folder");
  show(review);
  const chatBadge = strings(find(bar.render(), "review-changes"));
  scope.panes = allPanes; scope.terminals = () => [];
  show(review);
  assert.deepEqual(strings(find(bar.render(), "review-changes")), chatBadge, "chat and terminal show identical line totals for the same repository");
  show({ ...review, unmerged: 0, changed: 0, ahead: 0, behind: 0 });
  assert.deepEqual(keys(find(bar.render(), "pulls-review")), ["tip-review-pick"], "no counts: the icon stays, the way in on a clean default branch");
  assert.ok("rounded_r" in find(bar.render(), "review-pick").style);
  show({ ...review, newer: 1, gone: true });
  assert.deepEqual(strings(find(bar.render(), "review-open")), ["4", "ahead of main · merged?", "+12", "−4"], "a deleted upstream shows, not only in the label");
  // In a narrow bar the counts stand alone; the hover label gives back the words, and the accessibility label stays whole.
  state["bar.compact"] = true;
  assert.deepEqual(strings(find(bar.render(), "review-open")), ["4", "+12", "−4"]);
  fire(find(bar.render(), "review-open"), "on_hover", true, cx);
  assert.deepEqual(strings(find(bar.render(), "tip-review-open").style.content), ["4 ahead of main · merged?"]);
  fire(find(bar.render(), "review-open"), "on_hover", false, cx);
  assert.match(find(bar.render(), "review-open").style.accessibility_label, /^Review the branch: 4 commits on feat/);
  delete state["bar.compact"];
  assert.equal(find(bar.render(), "review-open").style.accessibility_label,
    "Review the branch: 4 commits on feat, not on main · main has 1 newer commit · origin/feat is gone, likely merged");
  const full = status;
  status = full.replace(/^# branch\.ab .*\n/m, "");
  const lost = await scope.readReview("/repo");
  assert.deepEqual([lost.gone, lost.ahead, lost.behind], [true, 0, 0], "an upstream without branch.ab is gone");
  status = full.replace("origin/feat", "origin/main");
  const tracking = await scope.readReview("/repo");
  assert.deepEqual([tracking.ahead, tracking.behind], [0, 1], "tracking main: ↑ repeats N ahead of main, so it goes; ↓ stays");
  // With origin/main the label names the remote ref: a fork's origin/main can lag the upstream it mirrors.
  refs["origin/main...HEAD"] = "0\t43\n";
  show(await scope.readReview("/repo"));
  assert.equal(find(bar.render(), "review-open").style.accessibility_label, "Review the branch: 43 commits on feat, not on origin/main");
  assert.deepEqual(strings(find(bar.render(), "review-open")), ["43", "ahead of main", "+12", "−4"], "the bar stays short: the remote ref is left to the label");
  delete refs["origin/main...HEAD"];
  refs["main...HEAD"] = "0\t0\n";
  assert.equal((await scope.readReview("/repo")).unmerged, 0, "nothing past main: no Review");
  refs["main...HEAD"] = "0\t4\n";
  for (const head of ["(detached)", "main"]) {
    status = full.replace("# branch.head feat", `# branch.head ${head}`);
    assert.equal((await scope.readReview("/repo")).unmerged, 0, `on ${head} the CLI opens its ref picker: no Review`);
  }

  // It sizes its block to the bar, its gap to what follows included, in logical pixels, once per change; with no bar, to nothing.
  show(review);
  const fit = () => find(bar.render(), "review-fit");
  assert.equal(fit().style.pr, 8);
  fire(fit(), "on_size_change", { width: 220 });
  fire(fit(), "on_size_change", { width: 220 });
  assert.deepEqual(calls.splice(0), [["layout.resize", { id: "review", px: 200 }]]);
  Object.assign(shown, { pane: "p9", cwd: "/other" });
  assert.equal(fit().style.pr, undefined, "no bar, no gap");
  fire(fit(), "on_size_change", { width: 0 });
  assert.deepEqual(calls.splice(0), [["layout.resize", { id: "review", px: 0 }]]);
  Object.assign(shown, { pane: "p1", cwd: undefined });
  const { mod: loose } = load();
  fire(find(loose.render(), "review-fit"), "on_size_change", { width: 220 });
  assert.equal(calls.length, 0, "without a block it leaves the layout alone");

  // In a real repository: a change worth a read reads a second after the last read at the soonest; one Git ignores
  // (macOS reports them), or of Git's own files but HEAD and refs, waits for the 10 s.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pulls-review-")));
  try {
    spawnSync("git", ["init", "-q"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, ".gitignore"), "node_modules/\n");
    const { scope: watcher } = load();
    watcher.exec = async (command, args, { cwd }) => { const r = spawnSync(command, args, { cwd, encoding: "utf8" }); return { code: r.status, stdout: r.stdout }; };
    const empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    assert.deepEqual(plain(await watcher.lineStats(tmp, empty, true)), { add: 1, del: 0 }, "an unborn repository counts new files");
    assert.equal(fs.existsSync(path.join(tmp, ".git/index")), false, "counting must not create the user's index");
    const git = (...args) => { const r = spawnSync("git", args, { cwd: tmp, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
    fs.writeFileSync(path.join(tmp, "tracked.txt"), "old\n");
    git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
    fs.writeFileSync(path.join(tmp, "tracked.txt"), "new\nmore\n");
    fs.writeFileSync(path.join(tmp, "staged.txt"), "staged\n"); git("add", "staged.txt");
    fs.writeFileSync(path.join(tmp, "new file\nwith newline.txt"), "first\nlast");
    fs.writeFileSync(path.join(tmp, "image.bin"), Buffer.from([0, 1, 2]));
    fs.mkdirSync(path.join(tmp, "node_modules")); fs.writeFileSync(path.join(tmp, "node_modules/ignored.txt"), "ignored\n");
    const beforeIndex = fs.readFileSync(path.join(tmp, ".git/index"));
    assert.deepEqual(plain(await watcher.lineStats(tmp, "HEAD", true)), { add: 5, del: 1 }, "worktree totals include staged, unstaged and new text, excluding ignored and binary files");
    assert.deepEqual(fs.readFileSync(path.join(tmp, ".git/index")), beforeIndex, "the real staging index stays byte-for-byte unchanged");
    const under = (...files) => files.map(f => path.join(tmp, f));
    assert.equal(await watcher.touchesDiff(tmp, under("node_modules/x", "node_modules/y")), false, "only ignored files");
    assert.equal(await watcher.touchesDiff(tmp, under("node_modules/x", "src/a.js")), true, "one that isn't");
    assert.equal(await watcher.touchesDiff(tmp, under(".git/index", ".git/objects/ab/cd", ".git")), false, "Git's own files");
    assert.equal(await watcher.touchesDiff(tmp, under(".git/HEAD")), true);
    assert.equal(await watcher.touchesDiff(tmp, under(".git/refs/heads/main")), true);
    assert.equal(await watcher.touchesDiff(tmp, [tmp]), true, "the root, for everything");
    assert.equal(await watcher.touchesDiff(tmp, ["/elsewhere/x"]), true, "what Git can't judge");
    let tick, change;
    const wcx = { notify() {}, spawn: (f) => f(wcx), timer: { every: (_ms, f) => { tick = f; } } };
    watcher.panes = () => [{ pane: "p1", tab: "b", cwd: tmp }];
    watcher.watchFolder = () => new Promise(resolve => { change = resolve; });
    const view = {};
    watcher.watchReview(view, wcx);
    tick(wcx); await new Promise(setImmediate);
    const [key] = view.reviewAt.keys(), readAt = view.reviewAt.get(key);
    assert.equal(view.reviews.get(key)?.root, tmp);
    change(under("node_modules/x")); await new Promise(setImmediate);
    assert.equal(view.reviewAt.get(key), readAt, "an ignored change");
    change(under("src/a.js")); await new Promise(setImmediate);
    assert.ok(Date.now() - view.reviewAt.get(key) >= 9000 && view.reviewAt.get(key) <= readAt, "a change: the 10 s rule reads a second after the last read");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // The logo reads on click, then its menu's rows open one commit, or one branch against the base.
  // Two git processes: the log and one for-each-ref, which counts each branch too; a Git before 2.41 has no
  // %(ahead-behind) and fails it, and the names come again without counts.
  const ranges = [], gits = [];
  let oldGit = false;
  const exec = scope.exec = async (_command, args) => {
    gits.push(args.find(a => a === "log" || a === "for-each-ref") ?? args.join(" "));
    if (args.includes("log")) { ranges.push(args.at(-1)); return { code: 0, stdout: `abcdef123456\x1ffix: a\x1f${Math.floor(Date.now() / 1000) - 7260}\x1fAvery\n` }; }
    if (args.includes("rev-list")) return { code: 0, stdout: "abcdef123456\n" };
    // Each branch: name, last subject, its time, author, upstream, its track, worktree, then (Git 2.41) ahead and behind.
    const format = args.find(a => a.startsWith("--format=%(refname:short)%1f")), counting = format?.endsWith("%1f%(ahead-behind:origin/main)");
    const refs = (ab) => [["feat", "wip", 60, "Avery", "origin/feat", "", "/repo", "0 0"], ["Other", "add other", 10800, "Blake", "origin/Other", "ahead 2", "/Users/me/wt/other", "3 1"]]
      .map(([name, subject, age, ...rest]) => [name, subject, Math.floor(Date.now() / 1000) - age, ...rest].slice(0, ab ? 8 : 7).join("\x1f")).join("\n") + "\n";
    if (counting) return oldGit ? { code: 128, stdout: "" } : { code: 0, stdout: refs(true) };
    if (format) return { code: 0, stdout: refs(false) };
    return { code: 128, stdout: "" };
  };
  const r = { root: "/repo", branch: "feat", base: "main", baseRef: "origin/main", unmerged: 4 };
  let reading;
  const run = { ...cx, spawn: fn => { reading = fn(run); } };
  const click = async (picked) => {
    show(picked);
    fire(find(bar.render(), "review-pick"), "on_mouse_down:left", { position: { x: 900, y: 20 } }, cx);
    fire(find(bar.render(), "review-pick"), "on_click", {}, run);
    await reading;
    return overlays.at(-1);
  };
  const spec = await click(r);
  assert.equal(spec.width, 560);
  assert.equal(ranges.at(-1), "origin/main..HEAD", "the branch's own commits");
  assert.deepEqual(gits.splice(0), ["log", "for-each-ref"]);
  const { time: otherTime, ...other } = plain(spec.props.branches)[0];
  assert.deepEqual([spec.props.branches.length, other], [1, { name: "Other", subject: "add other", author: "Blake", upstream: "origin/Other", track: "ahead 2", worktree: "/Users/me/wt/other", count: 3, behind: 1 }],
    "the current branch isn't offered against itself; each comes with its last commit, upstream, worktree and counts, from the one call");
  assert.ok(Math.abs(Date.now() - 3 * 36e5 - otherTime) < 5000);
  assert.equal(spec.height, 10 + 36 + 36 + 32, "the popup fits the switch and the longer page, so turning pages doesn't resize it");
  assert.equal(spec.props.height, spec.height, "and the menu sets that height itself: a popup's is only a maximum");
  assert.deepEqual([spec.mod, spec.props.menu], ["pulls-review", "review"]);
  assert.deepEqual(plain(spec.at), { x: 892, y: 40 * zoom }, "it hangs from the bar under the press, not over the bar");
  fire(find(bar.render(), "review-open"), "on_click", {}, cx);
  assert.deepEqual(launched.at(-1), { root: "/repo", args: [], page: "/branch/feat" }, "a count's click opens its diff without starting an agent review");
  const { mod: menu } = load({ ...spec.props, overlay: "m1" });
  const shut = closed.length;
  fire(find(menu.render(), "review-commit-abcdef123456"), "on_click", {}, cx);
  assert.deepEqual(launched.at(-1), { root: "/repo", args: ["abcdef123456"], page: "/commit/abcdef123456", overlay: "m1" }, "a menu pick doesn't analyze");
  assert.equal(closed.length, shut, "launch closes the menu when done: closing first would stop its task");
  assert.equal(find(menu.render(), "review-branch-Other"), null, "commits first, the branches on a page of their own");
  fire(find(menu.render(), "review-tab-branches"), "on_click", {}, cx);
  assert.deepEqual([find(menu.render(), "review-commit-abcdef123456"), strings(find(menu.render(), "review-branch-Other"))], [null, ["Other", "add other", "3 ahead", "3h"]],
    "a branch's row: its name, its last commit, how far ahead and how old");
  fire(find(menu.render(), "review-branch-Other"), "on_click", {}, cx);
  assert.deepEqual([launched.at(-1).args, launched.at(-1).page], [["origin/main...Other"], "/compare/origin/main...Other"]);
  // With the review pane showing this repository's diff: its count lit, one commit's place and steps, the menu on its commits.
  const list = ["c1", "c2", "c3"].map(sha => ({ sha, subject: sha, time: Date.now() - 36e5 }));
  const pane = (page, base = "/branch/feat", commits = list) => { state["review.shown"] = { b: { root: "/repo", page, base, commits } }; };
  pane("/branch/feat"); show(r);
  let lit = bar.render();
  assert.equal(find(lit, "review-open").style.bg, theme.hover);
  assert.equal(find(lit, "review-open").style.accessibility_label, "Review the branch: 4 commits on feat, not on origin/main, shown");
  assert.equal(find(lit, "review-commits"), null, "the whole diff has no place to show");
  pane("/commit/c2"); lit = bar.render();
  assert.deepEqual(strings(find(lit, "review-commits")), ["Commit 2 of 3"]);
  assert.ok("rounded_r" in find(lit, "commit-newer").style && !("rounded_r" in find(lit, "review-open").style), "the last part's fill follows the outline's corner");
  fire(find(lit, "commit-older"), "on_click", {}, cx);
  assert.deepEqual([state.review.tab, state.review.root, state.review.page, state.review.base], ["b", "/repo", "/commit/c1", "/branch/feat"]);
  fire(find(lit, "commit-newer"), "on_click", {}, cx);
  assert.equal(state.review.page, "/commit/c3");
  pane("/commit/c3");
  assert.equal(find(bar.render(), "commit-newer").handlers.on_click, undefined, "no newer commit");
  pane("/commit/c2");
  gits.length = 0;
  const within = await click(r);
  assert.deepEqual(gits.splice(0), ["for-each-ref"], "inside a review the menu lists its commits: no log");
  assert.deepEqual(plain(within.props.commits.map(c => c.sha)), ["c3", "c2", "c1"], "newest first, as the log's");
  assert.deepEqual(plain(within.props.within), { tab: "b", root: "/repo", base: "/branch/feat", sha: "c2" });
  assert.equal(within.height, 10 + 36 + 36 + 4 * 32, "the popup fits All changes too");
  const inMenu = load(within.props).mod;
  const marked = (id) => walk(find(inMenu.render(), id)).some(n => n.source === "mods/pulls-review/check.svg");
  assert.deepEqual([marked("review-commit-c2"), marked("review-commit-c1"), marked("review-all")], [true, false, false], "the commit shown is checked");
  // Commits first, All changes on top inside a review, no branch among them.
  const rowsOf = (m) => ["review-all", "review-branch-Other", "review-commit-c3", "review-commit-c2", "review-commit-c1"].filter(id => find(m.render(), id));
  const ids = rowsOf(inMenu);
  assert.deepEqual(ids, ["review-all", "review-commit-c3", "review-commit-c2", "review-commit-c1"]);
  assert.deepEqual(strings(find(inMenu.render(), "review-menu")).filter(text => /^(Commits|Branches|\d+|in this review)$/.test(text)), ["Commits", "3", "Branches", "1", "in this review"],
    "the switch counts each page, and says what the page shown lists");
  // The highlight as the Actions and New menus': `selected`, on the top row first, moved by ↑/↓ (round) and by the pointer.
  const highlighted = () => ids.filter(id => find(inMenu.render(), id)?.style.bg === theme.selected);
  assert.deepEqual(highlighted(), ["review-all"]);
  const key = (k) => fire(find(inMenu.render(), "review-menu"), "on_key_down", { key: k }, cx);
  key("down");
  assert.deepEqual(highlighted(), ["review-commit-c3"]);
  const cardOf = (id) => strings(find(find(inMenu.render(), id), `details-${id}`).style.content);
  assert.equal(cardOf("review-commit-c3")[0], "c3", "the card follows the keys to a commit");
  key("up");
  assert.deepEqual(cardOf("review-commit-c3"), [], "and closes off it");
  key("up");
  assert.deepEqual(highlighted(), ["review-commit-c1"], "up from the top goes round to the bottom");
  fire(find(inMenu.render(), "review-commit-c3"), "on_hover", true, cx);
  assert.deepEqual(highlighted(), ["review-commit-c3"], "the pointer moves it too");
  assert.equal(find(inMenu.render(), "review-commit-c2").hoverStyle.bg, theme.foreground + "0a", "the rest lift faintly under the pointer");
  fire(find(inMenu.render(), "review-commit-c1"), "on_click", {}, cx);
  assert.deepEqual([state.review.page, state.review.base], ["/commit/c1", "/branch/feat"], "a pick stays in this diff");
  fire(find(inMenu.render(), "review-all"), "on_click", {}, cx);
  assert.equal(state.review.page, "/branch/feat");
  // Tab turns to the branches' page, and back.
  key("tab");
  assert.deepEqual(rowsOf(inMenu), ["review-branch-Other"], "no commit among the branches");
  assert.equal(strings(find(inMenu.render(), "review-menu")).at(-5), "vs main");
  // A branch's card, as a commit's: its last commit, then how it stands against the base and its upstream, and where it's checked out.
  key("down");
  const [branchName, branchSubject, branchAge, ...branchRest] = cardOf("review-branch-Other");
  assert.deepEqual([branchName, branchSubject, branchRest], ["Other", "add other", ["B", "Blake", "3 ahead of main, 1 behind", "2 not pushed · origin/Other", "Checked out in ~/wt/other"]]);
  assert.match(branchAge, /^3h ago · /);
  fire(find(inMenu.render(), "review-branch-Other"), "on_click", {}, cx);
  assert.deepEqual(launched.at(-1).args, ["origin/main...Other"], "a branch is a new diff");
  key("tab");
  assert.deepEqual(rowsOf(inMenu), ids);
  const top = find(inMenu.render(), "review-menu").items.map(n => n.key);
  assert.ok(top.includes("review-all") && top.includes("review-commit-list") && !top.includes("review-branches"), "All changes and the switch outside the list");
  const many = load({ ...within.props, branches: Array.from({ length: 9 }, (_, i) => ({ name: `b${i}`, count: 1 })) }).mod;
  fire(find(many.render(), "review-tab-branches"), "on_click", {}, cx);
  // The lists scroll by script, as the shipped picker's: rows keep their handlers, ↑/↓ keep the highlight in view, the wheel
  // takes the highlight along. Until the list is measured every row is drawn; then only those in view, where the scroll puts them.
  const branchRow = (i) => find(many.render(), `review-branch-b${i}`);
  assert.ok(branchRow(8), "unmeasured: all drawn");
  fire(find(many.render(), "review-branches"), "on_size_change", { width: 500, height: 4 * 32 * zoom }, cx);
  assert.deepEqual([branchRow(3)?.style.top, branchRow(4)], [3 * 32, null], "measured: the four in view");
  const manyKey = (k) => fire(find(many.render(), "review-menu"), "on_key_down", { key: k }, cx);
  for (let i = 0; i < 5; i++) manyKey("down");
  assert.equal(branchRow(5).style.bg, theme.selected);
  assert.deepEqual([branchRow(5).style.top, branchRow(1)], [3 * 32, null], "↑/↓ scroll the highlight into view, at the bottom edge");
  // Two events before the next render, as a trackpad sends them: both count.
  const wheeled = find(many.render(), "review-branches");
  for (let i = 0; i < 2; i++) fire(wheeled, "on_scroll_wheel", { delta: { x: 0, y: 32 * zoom } }, cx);
  assert.deepEqual([branchRow(0)?.style.top, branchRow(4)], [0, null], "the wheel scrolls back up");
  assert.equal(branchRow(3).style.bg, theme.selected, "and the highlight comes along, to the last row in view");
  // The logo toggles: a press outside the popup closes it, before or just after the press reaches the bar; its click leaves it closed.
  const menus = () => overlays.length, logoButton = () => find(bar.render(), "review-pick");
  const pressLogo = () => fire(logoButton(), "on_mouse_down:left", { position: { x: 900, y: 20 } }, cx);
  const menusBefore = menus();
  inMenu.close(); pressLogo(); fire(logoButton(), "on_click", {}, run); await reading;
  assert.equal(menus(), menusBefore, "closed just before the press");
  pressLogo(); inMenu.close(); fire(logoButton(), "on_click", {}, run); await reading;
  assert.equal(menus(), menusBefore, "closed just after it");
  state["pulls-review.menuClosed"] = Date.now() - 1000;
  pressLogo(); fire(logoButton(), "on_click", {}, run); await reading;
  assert.equal(menus(), menusBefore + 1, "closed long ago, by Esc or a pick: the click opens it");
  // Clicks while it's still reading open it once.
  pressLogo(); fire(logoButton(), "on_click", {}, run); fire(logoButton(), "on_click", {}, run); await reading;
  assert.equal(menus(), menusBefore + 2);
  delete state["pulls-review.menuClosed"];
  // Enter takes the top row: All changes, until a search hides it.
  let enter, query = "";
  const placeholders = [];
  const scoped = load(within.props);
  scoped.scope.InputState = { new: (options) => { placeholders.push(options.placeholder); return { on: (event, fn) => { if (event === "submit") enter = fn; }, value: () => query, focus() {} }; } };
  scoped.scope.initReviewMenu(scoped.mod);
  state.review = null; enter({}, cx);
  assert.equal(state.review.page, "/branch/feat");
  query = "c1";
  assert.equal(find(scoped.mod.render(), "review-all"), null);
  enter({}, cx);
  assert.equal(state.review.page, "/commit/c1");
  // The search says what there is to search.
  const alone = load({ ...within.props, branches: [] });
  alone.scope.InputState = scoped.scope.InputState;
  alone.scope.initReviewMenu(alone.mod);
  assert.deepEqual(placeholders, ["Search commits and branches", "Search commits"]);
  // A single commit opened from the log has no commits of its own to step through: the menu stays on the log.
  pane("/commit/abc", "/commit/abc", [list[0]]);
  assert.equal((await click(r)).props.within, null);
  // Another repository's diff beside this terminal: nothing lit.
  state["review.shown"].b.root = "/other";
  assert.ok(!("bg" in find(bar.render(), "review-open").style));
  delete state["review.shown"]; delete state.review;
  // Search narrows both lists; Enter opens the first left.
  const searching = load(spec.props);
  let typed = "", submit, change;
  searching.scope.InputState = { new: () => ({ on: (event, fn) => { if (event === "submit") submit = fn; else if (event === "change") change = fn; }, value: () => typed, focus() {} }) };
  searching.scope.initReviewMenu(searching.mod);
  const type = (text) => { typed = text; change({}, cx); };
  fire(find(searching.mod.render(), "review-menu"), "on_key_down", { key: "down" }, cx);
  submit({}, cx);
  assert.deepEqual(launched.at(-1).args, ["abcdef123456"], "Enter opens the highlighted row");
  type("oTHER");
  assert.equal(find(searching.mod.render(), "review-commit-abcdef123456"), null, "a commit that doesn't match goes");
  assert.ok(find(searching.mod.render(), "review-branch-Other"), "matching ignores case");
  submit({}, cx);
  assert.deepEqual(launched.at(-1).args, ["origin/main...Other"], "Enter opens the only match left");
  type("abcdef");
  const commitRow = () => find(searching.mod.render(), "review-commit-abcdef123456");
  assert.deepEqual(strings(commitRow()), ["fix:", "a", "2h"], "a sha's start matches; one line: the dimmed prefix, the subject, a short age, no sha");
  const card = () => strings(find(commitRow(), "details-review-commit-abcdef123456").style.content);
  assert.deepEqual(card(), [], "its card waits for the hover");
  fire(commitRow(), "on_hover", true, cx);
  const [title, age, ...who] = card();
  assert.deepEqual([title, who], ["fix: a", ["A", "Avery"]], "hovered: the whole subject, then its author");
  assert.match(age, /^2h ago · [A-Z][a-z]{2} \d+, \d\d:\d\d$/, "and when, to the minute");
  assert.equal(find(commitRow(), "details-review-commit-abcdef123456").style.anchor, "top_right", "on the row's left: the menu hangs at the window's right");
  fire(commitRow(), "on_hover", false, cx);
  assert.deepEqual(card(), [], "gone with the pointer");
  // Not pushed: ↑ in the row, and the card says where it isn't.
  const picks = await scope.readPicks({ ...r, upstream: "origin/feat" }, true);
  assert.deepEqual(plain(picks.unpushed), ["abcdef123456"], "the upstream's missing commits, read beside the log");
  gits.length = 0;
  assert.deepEqual(plain((await scope.readPicks({ ...r, upstream: "origin/feat" }, false)).unpushed), [], "inside a review the commits may be another branch's: not read");
  assert.ok(!gits.some(g => g.startsWith("rev-list")));
  gits.length = 0;
  const pushing = load({ ...spec.props, upstream: "origin/feat", unpushed: picks.unpushed });
  const outRow = () => find(pushing.mod.render(), "review-commit-abcdef123456");
  assert.deepEqual(strings(outRow()), ["fix:", "a", "↑", "2h"]);
  fire(outRow(), "on_hover", true, cx);
  assert.equal(strings(find(outRow(), "details-review-commit-abcdef123456").style.content).at(-1), "Not on origin/feat yet");
  submit({}, cx);
  assert.deepEqual(launched.at(-1).args, ["abcdef123456"]);
  type("nope");
  const opened = launched.length;
  submit({}, cx);
  assert.equal(launched.length, opened, "no match: Enter opens nothing");
  await click({ ...r, branch: "main", unmerged: 0 });
  assert.equal(ranges.at(-1), "HEAD", "on the default branch: its recent commits");
  delete bar.reviewPress;
  fire(find(bar.render(), "review-pick"), "on_click", {}, run);
  await reading;
  assert.equal(overlays.at(-1).at, undefined, "a click with no press opens at the pointer");
  const before = overlays.length;
  scope.exec = async () => ({ code: 128, stdout: "" });
  await click(r);
  assert.equal(overlays.length, before, "nothing to pick, no menu");
  scope.exec = exec;
  oldGit = true; gits.length = 0;
  const old = await click(r);
  assert.deepEqual(gits.splice(0).filter(g => g === "for-each-ref"), ["for-each-ref", "for-each-ref"]);
  assert.deepEqual([old.props.branches[0].name, "count" in old.props.branches[0]], ["Other", false], "an older Git: the branches without counts");
  const oldMenu = load(old.props).mod;
  fire(find(oldMenu.render(), "review-tab-branches"), "on_click", {}, cx);
  const uncounted = find(oldMenu.render(), "review-branch-Other");
  assert.deepEqual([strings(uncounted), uncounted.style.accessibility_label], [["Other", "add other", "3h"], "Review branch Other"]);

  // Opened as an overlay (`mod.open:pulls-review`) it reviews the focused pane's worktree and closes itself: in "herdr"
  // mode, the shared sidebar opens without changing any terminal panes.
  calls.length = 0;
  const { mod: launcher, scope: opener } = load({ overlay: "o1" }, (scope) => {
    scope.exec = async (_command, args) => args.includes("--show-toplevel") ? { code: 0, stdout: "/repo\n" } : { code: 0, stdout: args.includes("status") ? " M a.js\n" : "" };
  });
  await new Promise(setImmediate);
  assert.deepEqual(calls, [["layout.select", { stack: "panel-body", child: "review" }], ["layout.show", { id: "panel" }]]);
  assert.equal(state["review.sidebar"].b.root, "/repo");
  assert.equal(state["review.sidebar"].b.page, "/worktree");
  assert.deepEqual(closed.at(-1), "o1");
  assert.equal(find(launcher.render(), "review-fit"), null, "nothing to see while it works");
  // From the bar, what it already knows: no git, no overlay to close.
  calls.length = 0;
  const shutBefore = closed.length;
  opener.exec = async (_command, args) => assert.fail(`git ${args.join(" ")}`);
  await opener.launch({ root: "/repo", args: ["origin/feat...feat"], page: "/compare/origin/feat...feat", analyze: true });
  assert.deepEqual(calls, [["layout.select", { stack: "panel-body", child: "review" }], ["layout.show", { id: "panel" }]]);
  assert.equal(state["review.sidebar"].b.page, "/compare/origin/feat...feat");
  assert.equal(closed.length, shutBefore);
  assert.deepEqual(plain(notes), []);
  calls.length = 0;
  opener.layout = () => ({ id: "panel", hidden: false, children: [{ id: "panel-body", active: "review", children: [{ id: "review" }] }] });
  await opener.launch({ root: "/repo", args: [], page: "/compare/origin/feat...feat" });
  assert.deepEqual(calls, [["layout.hide", { id: "panel" }]], "clicking the shown review closes the sidebar");
  shown.tab = "other";
  await opener.launch({ root: "/other", args: ["--worktree"], page: "/worktree" });
  assert.equal(state["review.sidebar"].b.root, "/repo");
  assert.equal(state["review.sidebar"].other.root, "/other", "each tab keeps its selected diff");
  const beforeStep = state["review.sidebar"].b.n;
  vm.runInContext('showPage({ tab: "b", root: "/repo", base: "/worktree" }, "/commit/abc")', opener);
  assert.equal(state["review.sidebar"].b.page, "/commit/abc");
  assert.equal(state["review.sidebar"].b.base, "/worktree");
  assert.ok(state["review.sidebar"].b.n > beforeStep, "commit navigation delivers a new sidebar request");
  assert.equal(state["review.sidebar"].other.root, "/other");
  shown.tab = "b";

  // A review pane starts only when shown and shared outlives the app, so a run's word from before a restart would spin on
  // in its tab and its Inbox row. The bar, always shown, drops it; only the bar: an overlay opens with every menu.
  state["review.status"] = { a: "working", b: "done", c: "blocked" };
  load({ overlay: "o", page: "/x" });
  assert.equal(state["review.status"].a, "working", "opening a review isn't a restart");
  load({ block: "review" });
  assert.deepEqual(plain(state["review.status"]), { b: "done", c: "blocked" }, "how a run ended is still news");
  const kept = state["review.status"]; load({ block: "review" });
  assert.equal(state["review.status"], kept, "nothing to drop, nothing written: every write redraws every mod");

  console.log("ok: the Review bar's counts outlined and ruled, its block sized to fit, the branch menu and its search, opening a review");
})().catch(e => { console.error(e); process.exit(1); });
