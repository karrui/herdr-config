// Tests the mod's git logic against real throwaway repos (a bare "remote"
// included): parsing, labels and where they sit, lanes, menus, validation,
// and every action the menus run. Run: node tests/graph.test.mjs
import * as G from "../mods/git-graph/git.js";
import { layoutLanes } from "../mods/git-graph/lanes.js";
import * as R from "../mods/git-graph/repos.js";
import { executeAction } from "../mods/git-graph/execute.js";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
let n = 0;
const commit = (cwd, msg) => { n++; writeFileSync(join(cwd, `${msg}.txt`), msg); sh(cwd, "add", "."); execFileSync("git", ["commit", "-qm", msg], { cwd, env: { ...env, GIT_AUTHOR_DATE: `2026-01-01T00:00:${String(n).padStart(2, "0")}`, GIT_COMMITTER_DATE: `2026-01-01T00:00:${String(n).padStart(2, "0")}` } }); };

// A repo with a bare remote: main, feature (merged), fix (open), a tag.
const base = mkdtempSync(join(tmpdir(), "herdr-git-graph-")), remote = join(base, "remote.git"), repo = join(base, "repo");
sh(base, "init", "-q", "--bare", "-b", "main", remote);
sh(base, "init", "-q", "-b", "main", repo);
commit(repo, "init"); commit(repo, "two");
sh(repo, "checkout", "-qb", "feature"); commit(repo, "f1"); commit(repo, "f2");
sh(repo, "checkout", "-q", "main"); commit(repo, "three");
sh(repo, "checkout", "-qb", "fix"); commit(repo, "x1");
sh(repo, "checkout", "-q", "main");
execFileSync("git", ["merge", "-q", "--no-ff", "feature", "-m", "merge feature"], { cwd: repo, env });
sh(repo, "tag", "v1");
sh(repo, "remote", "add", "origin", remote);
sh(repo, "push", "-q", "origin", "main", "fix");
sh(repo, "fetch", "-q", "origin");

const load = (opts = { all: true, remotes: true, limit: 300 }) => {
  const r = git(repo, [...G.READ, ...G.logArgs(opts)]);
  assert.equal(r.code, 0, r.stderr);
  return G.parseLog(r.stdout);
};
const ctxOf = () => ({ root: repo, on: null,
  current: git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout.trim() || null,
  head: git(repo, ["rev-parse", "HEAD"]).stdout.trim(),
  branches: git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]).stdout.split("\n").filter(Boolean).map((r) => r.replace("refs/heads/", "")),
  remotes: git(repo, ["remote"]).stdout.split("\n").filter(Boolean) });

// ---- parsing and labels
let commits = load();
const tip = commits.find((c) => c.subject === "merge feature");
assert.ok(tip.head, "HEAD is the merge");
const labels = G.labelsOf(tip);
assert.deepEqual(labels.map((l) => [l.kind, l.parts.map((p) => `${p.kind}:${p.name}`)]),
  [["branch", ["branch:main", "remote:origin/main"]], ["tag", ["tag:v1"]]], "main carries origin, current first, then tag");
assert.equal(labels[0].head, true);
assert.deepEqual(G.labelsOf(tip, false).map((l) => l.parts.length), [1, 1], "hidden remotes drop the origin part");
const fixLabels = G.labelsOf(commits.find((c) => c.subject === "x1"));
assert.deepEqual(fixLabels[0].parts.map((p) => p.kind), ["branch", "remote"]);
// Widths are exact sums, and hits land on the part under the pointer.
const l0 = labels[0], start = 30;
assert.equal(l0.width, l0.parts[0].width + l0.parts[1].width + 2);
const leftOf = start + G.LABEL.GAP;
assert.equal(G.hitLabel(labels, leftOf - 1, start), null, "gap before the label");
assert.equal(G.hitLabel(labels, leftOf + 2, start).part.name, "main");
assert.equal(G.hitLabel(labels, leftOf + 1 + l0.parts[0].width + 1, start).part.name, "origin/main");
const tagLeft = leftOf + l0.width + G.LABEL.GAP;
assert.equal(G.hitLabel(labels, tagLeft + 3, start).part.name, "v1");
assert.equal(G.hitLabel(labels, tagLeft + labels[1].width + 1, start), null, "past the last label");
assert.equal(G.hitLabel([], 40, start), null);
assert.equal(G.hitLabel(labels, leftOf + 2, start, leftOf + 1), null, "clipped past the description edge");
assert.equal(G.hitLabel(labels, leftOf + 2, start, leftOf + 3).part.name, "main", "inside the edge still hits");
// Long names are cut so the drawn width stays what was measured.
const long = G.labelsOf({ refs: [{ kind: "branch", name: "a".repeat(60), head: false }] })[0];
assert.equal(long.parts[0].text.length, G.LABEL.MAX);
console.log("labels ok");

// ---- uncommitted row and dashed lane
const withU = G.withUncommitted(commits, 3, tip.hash);
assert.equal(withU[0].subject, "Uncommitted changes (3)");
const lanes = layoutLanes(withU);
assert.deepEqual(lanes.rows[0].segments, [[0, 0.5, 0, 1, 0, true]], "dashed down from the uncommitted row");
const headRow = lanes.rows[withU.indexOf(withU.find((c) => c.hash === tip.hash))];
assert.ok(headRow.segments.some((s) => s[5] && s[3] === 0.5), "the dashed line ends at HEAD");
assert.ok(headRow.segments.filter((s) => s[1] === 0.5).every((s) => !s[5]), "HEAD's own lines are solid");
assert.equal(G.withUncommitted(commits, 0, tip.hash), commits);
assert.deepEqual(G.parseStatus(" M a.txt\0?? b.txt\0D  c.txt\0UU d.txt\0"), [
  { path: "a.txt", status: "M", untracked: false, staged: false }, { path: "b.txt", status: "A", untracked: true, staged: false },
  { path: "c.txt", status: "D", untracked: false, staged: true }, { path: "d.txt", status: "U", untracked: false, staged: false }]);
// The graph reads everything from the pane's folder at once: from a subfolder,
// status still names paths from the root and the log is the whole history.
{
  const sub = join(repo, "deep", "er");
  execFileSync("mkdir", ["-p", sub]);
  writeFileSync(join(sub, "new.txt"), "x");
  const fromRoot = git(repo, [...G.READ, ...G.STATUS]).stdout, fromSub = git(sub, [...G.READ, ...G.STATUS]).stdout;
  assert.equal(fromSub, fromRoot);
  assert.ok(G.parseStatus(fromSub).some((f) => f.path === "deep/er/new.txt"));
  const args = G.logArgs({ all: true, remotes: true, limit: 300 });
  assert.equal(git(sub, [...G.READ, ...args]).stdout, git(repo, [...G.READ, ...args]).stdout);
  rmSync(join(repo, "deep"), { recursive: true });
}
console.log("uncommitted ok");


// ---- lanes: every line entering a row continues one leaving the row above
{
  const all = G.withUncommitted(load(), 1, git(repo, ["rev-parse", "HEAD"]).stdout.trim());
  const { rows } = layoutLanes(all);
  const index = new Map(all.map((c, i) => [c.hash, i]));
  for (let i = 1; i < rows.length; i++) {
    const below = [...new Set(rows[i - 1].segments.filter((s) => s[3] === 1).map((s) => s[2]))].sort();
    const above = [...new Set(rows[i].segments.filter((s) => s[1] === 0).map((s) => s[0]))].sort();
    assert.deepEqual(above, below, `row ${i} continuity`);
  }
  for (const [i, c] of all.entries()) for (const p of c.parents) assert.ok(index.get(p) > i, `parent of ${c.subject} comes later`);
  assert.deepEqual(layoutLanes([]), { rows: [], width: 1 });
  const oct = layoutLanes([{ hash: "m", parents: ["a", "b", "c"] }, { hash: "a", parents: [] }, { hash: "b", parents: [] }, { hash: "c", parents: [] }]);
  assert.deepEqual(oct.rows[0].segments, [[0, 0.5, 0, 1, 0, false], [0, 0.5, 1, 1, 1, false], [0, 0.5, 2, 1, 2, false]], "octopus merge");
  assert.deepEqual(layoutLanes([{ hash: "x", parents: ["gone"] }]).rows[0].segments, [[0, 0.5, 0, 1, 0, false]], "parent past the loaded range");
  console.log("lanes ok");
}
// ---- menus
const ctx = ctxOf();
const labelsIn = (items) => items.filter((i) => !i.separator).map((i) => i.label);
assert.deepEqual(labelsIn(G.menuFor({ kind: "branch", name: "main", commit: tip }, ctx)), ["Rename branch…", "Push branch…", "Copy branch name"], "no checkout/delete/merge of the current branch");
assert.deepEqual(labelsIn(G.menuFor({ kind: "branch", name: "fix", commit: tip }, ctx)),
  ["Checkout branch", "Rename branch…", "Delete branch…", "Merge into main…", "Rebase main on this branch…", "Push branch…", "Copy branch name"]);
assert.deepEqual(labelsIn(G.menuFor({ kind: "remote", name: "origin/fix", commit: tip }, ctx))[0], "Checkout fix", "a local branch with the name is checked out instead");
const headMenu = labelsIn(G.menuFor({ kind: "commit", commit: tip }, ctx));
assert.ok(!headMenu.includes("Checkout…") && !headMenu.includes("Cherry pick…") && headMenu.includes("Revert…"), "HEAD's own menu");
const items = G.menuFor({ kind: "commit", commit: commits.find((c) => c.subject === "two") }, ctx);
assert.ok(!items[0].separator && !items.at(-1).separator && items.every((it, i) => !(it.separator && items[i + 1]?.separator)), "separators only between sections");
assert.equal(G.menuHeight(items), 10 + items.filter((i) => !i.separator).length * 30 + items.filter((i) => i.separator).length * 9);
assert.ok(labelsIn(G.menuFor({ kind: "tag", name: "v1", commit: tip }, { ...ctx, remotes: [] })).every((l) => !l.startsWith("Push")), "no push without remotes");
console.log("menus ok");

// ---- validation: names never become options
const create = { type: "createBranch", hash: tip.hash, short: tip.hash.slice(0, 8) };
assert.match(G.validate(create, { name: "", checkout: false }, ctx), /empty/);
assert.match(G.validate(create, { name: "-D", checkout: false }, ctx), /can't start/);
assert.match(G.validate(create, { name: "a b", checkout: false }, ctx), /spaces/);
assert.equal(G.validate(create, { name: "ok", checkout: false }, ctx), null);
assert.match(G.validate({ type: "reset", hash: tip.hash, short: "x" }, { mode: "nuke" }, ctx), /Pick a mode/);
assert.equal(G.validate({ type: "addTag", hash: tip.hash, short: "x" }, { name: "t", message: "" }, ctx), null, "message is optional");
console.log("validation ok");

// ---- every action, for real, as the dialog would run it
const run = (action, over = {}) => {
  const c = ctxOf(), v = { ...G.initialValues(action, c), ...over };
  assert.equal(G.validate(action, v, c), null, `valid: ${action.type}`);
  for (const args of G.commandsFor(action, v, c)) {
    const r = git(repo, args);
    if (r.code !== 0) return { ok: false, message: G.gitError(r) };
  }
  return { ok: true, text: G.doneText(action, v) };
};
const ok = (r) => { assert.ok(r.ok, r.message); return r; };
const has = (args, text) => git(repo, args).stdout.includes(text);
const hashOf = (subject) => load().find((c) => c.subject === subject).hash;

ok(run({ type: "checkout", name: "fix" })); assert.equal(ctxOf().current, "fix");
ok(run({ type: "checkout", name: "main" }));
assert.equal(ok(run({ type: "createBranch", hash: hashOf("two"), short: "x" }, { name: "from-two" })).text, "Created branch from-two");
assert.equal(ctxOf().current, "main", "create without checkout stays");
ok(run({ type: "createBranch", hash: hashOf("two"), short: "x" }, { name: "co-two", checkout: true })); assert.equal(ctxOf().current, "co-two");
ok(run({ type: "checkout", name: "main" }));
ok(run({ type: "addTag", hash: hashOf("two"), short: "x" }, { name: "light" }));
ok(run({ type: "addTag", hash: hashOf("two"), short: "x" }, { name: "annot", message: "release notes" }));
assert.equal(git(repo, ["cat-file", "-t", "annot"]).stdout.trim(), "tag", "annotated");
assert.equal(git(repo, ["cat-file", "-t", "light"]).stdout.trim(), "commit", "lightweight");
ok(run({ type: "renameBranch", name: "from-two" }, { name: "renamed" })); assert.ok(ctxOf().branches.includes("renamed"));
ok(run({ type: "deleteBranch", name: "renamed" })); assert.ok(!ctxOf().branches.includes("renamed"), "merged branch deletes with -d");
const unmerged = run({ type: "deleteBranch", name: "fix" });
assert.ok(!unmerged.ok && /not fully merged/.test(unmerged.message), "unmerged branch refuses without force: " + unmerged.message);
ok(run({ type: "deleteTag", name: "light" })); assert.ok(!has(["tag"], "light"));
ok(run({ type: "push", name: "co-two" }, { remote: "origin", upstream: true }));
assert.ok(has(["ls-remote", "--heads", "origin"], "refs/heads/co-two"));
assert.equal(git(repo, ["config", "branch.co-two.remote"]).stdout.trim(), "origin", "upstream set");
ok(run({ type: "pushTag", name: "v1" }, { remote: "origin" })); assert.ok(has(["ls-remote", "--tags", "origin"], "refs/tags/v1"));
ok(run({ type: "deleteRemoteBranch", name: "origin/co-two", remote: "origin", branch: "co-two" }));
assert.ok(!has(["ls-remote", "--heads", "origin"], "co-two"));
ok(run({ type: "fetch" }));
// A remote branch without a local one: checkout makes a tracking branch.
sh(repo, "branch", "-D", "co-two"); sh(repo, "push", "-q", "origin", "fix:remote-only"); sh(repo, "fetch", "-q", "origin");
const ro = G.menuFor({ kind: "remote", name: "origin/remote-only", commit: tip }, ctxOf())[0];
assert.equal(ro.action.type, "checkoutRemote");
assert.equal(G.dialogFor(ro.action, ctxOf()).inputs[0].value, "remote-only", "local name defaults to the branch's");
ok(run(ro.action)); assert.equal(ctxOf().current, "remote-only");
assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "remote-only@{upstream}"]).stdout.trim(), "origin/remote-only");
ok(run({ type: "checkout", name: "main" }));
// Merge, with and without a merge commit.
const before = ctxOf().head;
ok(run({ type: "merge", ref: "fix", what: "branch fix" }, { noff: true }));
assert.equal(git(repo, ["rev-list", "--parents", "-n1", "HEAD"]).stdout.trim().split(" ").length, 3, "--no-ff made a merge commit");
ok(run({ type: "reset", hash: before, short: "x" }, { mode: "hard" })); assert.equal(ctxOf().head, before);
// Cherry pick and revert, of a plain commit and of a merge commit.
ok(run({ type: "cherryPick", hash: hashOf("x1"), short: "x", merge: false })); assert.ok(has(["log", "-1", "--format=%s"], "x1"));
ok(run({ type: "revert", hash: ctxOf().head, short: "x", merge: false })); assert.ok(has(["log", "-1", "--format=%s"], "Revert"));
ok(run({ type: "revert", hash: tip.hash, short: "x", merge: true })); assert.ok(has(["log", "-1", "--format=%s"], "Revert \"merge feature\""));
ok(run({ type: "reset", hash: before, short: "x" }, { mode: "hard" }));
// Soft and mixed keep the changes.
ok(run({ type: "reset", hash: hashOf("three"), short: "x" }, { mode: "soft" }));
assert.ok(git(repo, ["diff", "--cached", "--name-only"]).stdout.includes("f1.txt"), "soft: staged");
ok(run({ type: "reset", hash: before, short: "x" }, { mode: "hard" }));
// Rebase a branch on main.
ok(run({ type: "checkout", name: "fix" })); ok(run({ type: "rebase", ref: "main", what: "branch main" }));
assert.equal(git(repo, ["merge-base", "--is-ancestor", "main", "fix"]).code, 0, "fix now sits on main");
ok(run({ type: "checkout", name: "main" }));
// Conflicts come back as git's own words, and the repo is left for the person.
sh(repo, "checkout", "-qb", "clash", hashOf("two")); writeFileSync(join(repo, "two.txt"), "theirs"); sh(repo, "commit", "-qam", "theirs");
sh(repo, "checkout", "-q", "main"); writeFileSync(join(repo, "two.txt"), "ours"); sh(repo, "commit", "-qam", "ours");
const clash = run({ type: "merge", ref: "clash", what: "branch clash" });
assert.ok(!clash.ok && /CONFLICT|conflict/.test(clash.message), clash.message);
sh(repo, "merge", "--abort");
// Checkout a commit: detached.
ok(run({ type: "checkoutCommit", hash: hashOf("two"), short: "x" })); assert.equal(ctxOf().current, null);
ok(run({ type: "checkout", name: "main" }));
// Uncommitted: status, stash, reset.
writeFileSync(join(repo, "three.txt"), "edited"); writeFileSync(join(repo, "new.txt"), "new");
const st = G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout);
assert.deepEqual(st.map((f) => [f.path, f.status, f.staged]), [["three.txt", "M", false], ["new.txt", "A", false]]);
ok(run({ type: "stash" }, { message: "wip" }));
assert.equal(git(repo, ["status", "--porcelain"]).stdout, "", "untracked stashed too");
assert.ok(has(["stash", "list"], "wip"));
sh(repo, "stash", "pop", "-q");
ok(run({ type: "resetUncommitted" }, { mode: "hard" }));
assert.equal(git(repo, ["status", "--porcelain"]).stdout, "?? new.txt\n", "hard reset keeps untracked files");
// Commit: staging everything (untracked too), or only what's staged.
assert.deepEqual(labelsIn(G.menuFor({ kind: "uncommitted" }, ctxOf())), ["Commit…", "Stash uncommitted changes…", "Reset uncommitted changes…", "Show in Changes panel"]);
assert.match(G.validate({ type: "commit" }, { message: "  ", all: true }, ctxOf()), /empty/);
assert.throws(() => G.commandsFor({ type: "commit" }, { message: "" }), /Empty commit message/);
writeFileSync(join(repo, "three.txt"), "committed"); writeFileSync(join(repo, "new.txt"), "new");
assert.equal(ok(run({ type: "commit" }, { message: "--amend: a message, not an option" })).text, "Committed");
assert.equal(git(repo, ["log", "-1", "--format=%s"]).stdout.trim(), "--amend: a message, not an option");
assert.equal(git(repo, ["status", "--porcelain"]).stdout, "", "everything, untracked included, committed");
writeFileSync(join(repo, "a.txt"), "a"); writeFileSync(join(repo, "b.txt"), "b"); sh(repo, "add", "a.txt");
assert.deepEqual(G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout).map((f) => [f.path, f.staged]), [["a.txt", true], ["b.txt", false]]);
assert.equal(G.initialValues(G.menuFor({ kind: "uncommitted", staged: true }, ctxOf())[0].action, ctxOf()).all, false, "something staged: commit just that by default");
assert.equal(G.initialValues({ type: "commit", staged: false }, ctxOf()).all, true, "nothing staged: stage everything by default");
ok(run({ type: "commit" }, { message: "only staged", all: false }));
assert.equal(git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout, "a.txt\n", "without staging, only the index");
assert.ok(!run({ type: "commit" }, { message: "nothing staged", all: false }).ok, "git refuses an empty commit");
sh(repo, "reset", "-q", "--hard", "HEAD~2"); rmSync(join(repo, "b.txt")); rmSync(join(repo, "new.txt"), { force: true });
// The history read leaves .git untouched.
const idx = git(repo, ["rev-parse", "--git-path", "index"]).stdout.trim();
const m1 = statSync(join(repo, idx)).mtimeMs; git(repo, [...G.READ, ...G.STATUS]); git(repo, [...G.READ, ...G.logArgs({ all: true, remotes: true, limit: 300 })]);
assert.equal(statSync(join(repo, idx)).mtimeMs, m1, "reads don't touch the index");
console.log("actions ok");

// ---- files and diffs of a commit
const mergeC = load().find((c) => c.subject === "merge feature");
const fa = G.fileArgs(mergeC);
const files = G.joinFiles(git(repo, [...G.READ, ...fa.status]).stdout, git(repo, [...G.READ, ...fa.numstat]).stdout);
assert.deepEqual(files.map((f) => [f.status, f.path, f.add]), [["A", "f1.txt", 1], ["A", "f2.txt", 1]], "a merge's files against its first parent");
const root = load().find((c) => !c.parents.length), rf = G.fileArgs(root);
assert.deepEqual(G.joinFiles(git(repo, [...G.READ, ...rf.status]).stdout, git(repo, [...G.READ, ...rf.numstat]).stdout).map((f) => f.path), ["init.txt"]);
const rows = G.diffRows(git(repo, [...G.READ, ...G.diffArgs(mergeC, "f1.txt")]).stdout);
assert.equal(rows[0].kind, "@"); assert.deepEqual(rows[1], { kind: "+", number: 1, text: "f1" });
assert.ok(G.diffRows(git(repo, [...G.READ, ...G.diffArgs(root, "init.txt")]).stdout)[1].text === "init", "root commit diff");
assert.equal(G.diffRows(""), null);
// Empty repo and current-only scope.
const empty = join(base, "empty"); sh(base, "init", "-q", empty);
assert.notEqual(git(empty, G.logArgs({ all: false, remotes: true, limit: 300 })).code, 0, "HEAD scope fails without commits (handled as empty)");
const allEmpty = git(empty, G.logArgs({ all: true, remotes: true, limit: 300 }));
assert.equal(allEmpty.code, 0); assert.equal(G.parseLog(allEmpty.stdout).length, 0);
assert.ok(load({ all: true, remotes: false, limit: 300 }).every((c) => G.labelsOf(c, false).every((l) => l.kind !== "remote")));
// Refs outside branches, tags and remotes (another tool's checkpoints, a stash) are not walked; a detached HEAD is.
{
  const orphan = git(repo, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "t3 checkpoint"]).stdout.trim();
  sh(repo, "update-ref", "refs/t3/checkpoints/s/turn/0", orphan);
  assert.ok(!load().some((c) => c.hash === orphan), "a tool ref is not in the graph");
  sh(repo, "checkout", "-q", "--detach", orphan);
  assert.ok(load().some((c) => c.hash === orphan), "a detached HEAD is in the graph");
  sh(repo, "checkout", "-q", "main");
  sh(repo, "update-ref", "-d", "refs/t3/checkpoints/s/turn/0");
}
console.log("files ok");

// Commit metadata is untrusted: control characters stay inside their field.
const unusual = "subject with \x1e record and \x1f field separators";
const beforeUnusual = load().length;
sh(repo, "commit", "--allow-empty", "-qm", unusual);
const unusualLog = load();
const unusualCommit = unusualLog.find((c) => c.hash === ctxOf().head);
assert.equal(unusualCommit.subject, unusual);
assert.equal(unusualLog.length, beforeUnusual + 1, "metadata must not create extra rows");
const raw = git(repo, [...G.READ, ...G.logArgs({ all: false, remotes: true, limit: 1 })]).stdout;
assert.throws(() => G.parseLog(raw.slice(0, -1)), /framing/);
assert.throws(() => G.parseLog(raw.replace(unusualCommit.hash, "invalid")), /identity/);
assert.throws(() => G.parseLog(raw.replace(unusualCommit.hash, "--output=unexpected")), /identity/);
assert.equal(G.parseLog(raw.replaceAll(unusualCommit.hash, "a".repeat(64)))[0].hash.length, 64);
assert.deepEqual(G.parseRefs("refs/heads/-f, tag: refs/tags/--help, refs/remotes/-bad/x"), []);

// Direct/menu actions must not bypass validation by skipping a dialog.
for (const type of ["checkout", "deleteBranch", "deleteTag", "renameBranch", "push", "pushTag", "checkoutRemote"]) {
  assert.throws(() => G.commandsFor({ type, name: "-f" }, {}, ctxOf()), /ref name/);
}
assert.throws(() => G.commandsFor({ type: "reset", hash: tip.hash }, { mode: "hard --other" }, ctxOf()), /reset mode/);
assert.throws(() => G.commandsFor({ type: "push", name: "main" }, { remote: "--help" }, ctxOf()), /remote/);
assert.throws(() => G.commandsFor({ type: "fetch-unknown" }), /Unknown/);
assert.throws(() => G.fileArgs({ hash: "--output=unexpected", parents: [] }), /identity/);
assert.throws(() => G.diffArgs({ hash: tip.hash, parents: ["--bad"] }, "file"), /identity/);
console.log("untrusted history ok");
rmSync(base, { recursive: true, force: true });
// ---- Manygit: finding repositories under a folder, and one status call each
{
  const ws = mkdtempSync(join(tmpdir(), "herdr-manygit-"));
  const mk = (rel) => { const d = join(ws, rel); mkdirSync(d, { recursive: true }); sh(d, "init", "-q", "-b", "main"); return d; };
  const a = mk("a"); mk("b"); mk("group/c"); mk("node_modules/pruned"); mk(".hidden/pruned"); mk("one/two/three/deep");
  mkdirSync(join(ws, "plain/folder"), { recursive: true });
  const found = (depth) => R.parseFound(ws, spawnSync("find", R.findArgs(ws, depth), { encoding: "utf8" }).stdout);
  assert.deepEqual(found(3).map((r) => [r.group, r.name]), [["", "a"], ["", "b"], ["group", "c"]], "pruned, hidden and too-deep folders are skipped");
  assert.deepEqual(found(4).map((r) => r.name), ["a", "b", "c", "deep"], "a deeper search finds more");
  assert.deepEqual(found(1).map((r) => r.name), ["a", "b"]);
  // A folder reached through a symlink (macOS's /tmp, a symlinked checkout) is searched too.
  const link = `${ws}-link`; symlinkSync(ws, link);
  assert.deepEqual(R.parseFound(link, spawnSync("find", R.findArgs(link, 3), { encoding: "utf8" }).stdout).map((r) => r.name), ["a", "b", "c"], "symlinked folder");
  unlinkSync(link);
  // Not searched: a home, anything above one, and another machine's usual homes.
  for (const [dir, home, skip] of [["/", "/Users/me", true], ["/Users", "/Users/me", true], ["/Users/me/", "/Users/me", true],
    ["/Users/me/code", "/Users/me", false], ["/home/dev", null, true], ["/root", null, true], ["/mnt/data/dev-vera", null, false], ["/home/dev/work", null, false]]) {
    assert.equal(R.unsearched(dir, home), skip, `unsearched ${dir}`);
  }
  assert.equal(R.depthOf(9), R.DEPTH.default); assert.equal(R.depthOf(2), 2); assert.equal(R.depthOf(undefined), 3);
  assert.deepEqual(R.parseFound("/w", "/w/x/.git\n/elsewhere/y/.git\nfind: /w/locked: Permission denied\n").map((r) => r.name), ["x"], "only paths under the folder");

  // A clone with a bare remote: ahead, behind, both, dirty, no upstream, no remote, detached.
  const bare = join(ws, "remote.git"); sh(ws, "init", "-q", "--bare", "-b", "main", bare);
  const status = (dir) => R.parseRepoStatus(git(dir, R.REPO_STATUS).stdout);
  commit(a, "a1"); sh(a, "remote", "add", "origin", bare); sh(a, "push", "-q", "-u", "origin", "main");
  assert.deepEqual(status(a), { branch: "main", detached: false, head: git(a, ["rev-parse", "HEAD"]).stdout.trim(), upstream: "origin/main", gone: false, ahead: 0, behind: 0, dirty: 0, staged: 0 });
  assert.equal(R.parseRepoStatus("# branch.oid (initial)\0# branch.head main\0").head, null, "no commits yet");
  assert.deepEqual(R.syncOf({ ...status(a), hasRemote: true }), { kind: "ok", text: "✓" });
  commit(a, "a2"); writeFileSync(join(a, "a1.txt"), "edited"); writeFileSync(join(a, "untracked.txt"), "x");
  assert.deepEqual([status(a).ahead, status(a).dirty, status(a).staged], [1, 2, 0], "ahead by one, two files changed, none staged");
  sh(a, "add", "a1.txt"); assert.equal(status(a).staged, 1, "one staged"); sh(a, "reset", "-q");
  assert.equal(R.syncOf(status(a)).text, "↑1");
  sh(a, "reset", "-q", "--hard", "HEAD~1"); sh(a, "commit", "-q", "--allow-empty", "-m", "other"); sh(a, "fetch", "-q");
  const other = mkdtempSync(join(tmpdir(), "herdr-manygit-clone-")); sh(other, "clone", "-q", bare, "c"); commit(join(other, "c"), "theirs"); sh(join(other, "c"), "push", "-q");
  sh(a, "fetch", "-q");
  assert.deepEqual([status(a).ahead, status(a).behind], [1, 1]); assert.equal(R.syncOf(status(a)).kind, "diverged");
  sh(a, "checkout", "-qb", "local-only");
  assert.equal(status(a).upstream, null); assert.equal(R.syncOf({ ...status(a), hasRemote: true }).kind, "unpushed");
  assert.equal(R.syncOf({ ...R.parseRepoStatus(""), hasRemote: false }).kind, "local");
  assert.equal(git(a, R.LATEST_TAG).stdout, "", "no tags yet");
  sh(a, "tag", "v1.0"); assert.equal(git(a, R.LATEST_TAG).stdout.trim(), "v1.0", "the newest tag");
  sh(a, "checkout", "-q", "--detach"); assert.equal(status(a).detached, true);
  assert.equal(R.syncOf({ ...status(a), hasRemote: true }).kind, "ok", "detached isn't \"not pushed\"");
  // Fetch all's command: prompts off, through env, and a row behind after someone else pushed.
  sh(join(ws, "b"), "remote", "add", "origin", join(ws, "gone.git"));
  const fetchOut = spawnSync("env", R.FETCH, { cwd: join(ws, "b"), encoding: "utf8", env });
  assert.ok(fetchOut.status !== 0 && fetchOut.stderr.trim(), "an unreachable remote fails with git's words for the row");
  assert.equal(R.syncOf({ ...status(a), hasRemote: true }, "fatal: unable to access").text, "fetch failed");
  assert.equal(R.fetchable({ upstream: null, hasRemote: false }), false, "a local-only repository isn't fetched");
  assert.equal(R.fetchable(undefined), true); assert.equal(R.fetchable({ upstream: "origin/main" }), true);
  sh(a, "checkout", "-q", "main"); commit(join(other, "c"), "more"); sh(join(other, "c"), "push", "-q");
  assert.equal(spawnSync("env", R.FETCH, { cwd: a, encoding: "utf8", env }).status, 0);
  assert.equal(status(a).behind, 2, "the fetch brought the new commit");
  // A row's menu: Herdr's tabs first, then what its ↑/↓ asks for first.
  const remotes = R.parseRemotes(git(a, R.REMOTES).stdout);
  assert.deepEqual(remotes, [{ name: "origin", url: bare }]);
  assert.equal(R.webUrl("git@github.com:rabeeh-ta/manygit.git"), "https://github.com/rabeeh-ta/manygit");
  assert.equal(R.webUrl("ssh://git@gitlab.com/group/sub/repo.git"), "https://gitlab.com/group/sub/repo");
  assert.equal(R.webUrl("https://user:token@github.com/o/r.git"), "https://github.com/o/r", "credentials never reach the browser");
  assert.equal(R.webUrl(bare), null); assert.equal(R.webUrl("file:///srv/r.git"), null);
  assert.equal(R.webUrl("https://user:p@ss@host.com/o/r"), "https://host.com/o/r", "a password with @ is dropped whole");
  assert.equal(R.webUrl("ssh://git@host.example:2222/o/r.git"), "https://host.example/o/r", "the ssh port isn't the web's");
  assert.equal(R.webUrl("https://git.example.com:3000/o/r"), "https://git.example.com:3000/o/r");
  for (const u of ["../sibling", "github-work:o/r", "C:\\repos\\x"]) assert.equal(R.webUrl(u), null, `no page for ${u}`);
  const rowCtx = (st) => ({ root: a, on: null, current: st.branch, head: st.head, branches: [], remotes: ["origin"] });
  const rowMenu = (st, agents = []) => G.menuFor({ kind: "repo", path: a, status: st, agents, web: "https://github.com/o/r" }, rowCtx(st)).filter((i) => !i.separator).map((i) => i.label);
  const claude = { name: "Claude Code", icon: "icons/claude.svg", tint: false, run: ["claude"] };
  assert.deepEqual(rowMenu({ ...status(a), behind: 4, ahead: 0, dirty: 0 }, [claude]).slice(0, 4), ["New Claude Code tab", "New terminal tab", "Pull…", "Fetch"], "behind: Pull comes first");
  assert.equal(rowMenu({ ...status(a), ahead: 2, behind: 0 })[1], "Push…", "ahead: Push comes first");
  assert.equal(rowMenu({ ...status(a), upstream: null, hasRemote: true })[1], "Push and set upstream…");
  assert.ok(rowMenu({ ...status(a), dirty: 3 }).includes("Commit…") && !rowMenu({ ...status(a), dirty: 0 }).includes("Commit…"), "change actions only with changes");
  assert.ok(rowMenu(status(a)).includes("Open on github.com") && rowMenu(status(a)).includes("Copy path"));
  // Pull fast-forwards, run as the row's menu runs it: through executeAction, with a ctx built from the row's status.
  sh(a, "checkout", "-q", "main"); sh(a, "reset", "-q", "--hard", "origin/main"); sh(a, "reset", "-q", "--hard", "HEAD~1");
  const behindSt = status(a); assert.equal(behindSt.behind, 1);
  const run = (cmd, args, o) => Promise.resolve(spawnSync(cmd, args, { cwd: o.cwd, env, encoding: "utf8" })).then((r) => ({ code: r.status, stdout: r.stdout, stderr: r.stderr }));
  const pullCtx = { root: a, on: null, current: behindSt.branch, head: behindSt.head, branches: [], remotes: ["origin"] };
  const moved = { ...pullCtx, head: "0".repeat(40) };
  assert.equal((await executeAction({ type: "pull", upstream: "origin/main" }, {}, moved, run)).stale, true, "a row whose HEAD moved is refused");
  assert.equal((await executeAction({ type: "pull", upstream: "origin/main" }, {}, pullCtx, run)).ok, true);
  assert.equal(status(a).behind, 0, "pulled");
  // An upstream deleted on the remote: git names it but counts nothing. Not "in sync", and no Pull.
  sh(a, "checkout", "-qb", "doomed"); sh(a, "push", "-q", "-u", "origin", "doomed"); sh(a, "push", "-q", "origin", "--delete", "doomed"); sh(a, "fetch", "-q", "--prune");
  assert.equal(status(a).gone, true); assert.equal(R.syncOf({ ...status(a), hasRemote: true }).kind, "gone");
  assert.ok(!rowMenu({ ...status(a), hasRemote: true }).includes("Pull…"), "no Pull from a gone upstream");
  sh(a, "checkout", "-q", "main");
  assert.equal(R.syncOf(undefined).kind, "loading"); assert.equal(R.syncOf({ error: "dubious ownership" }).kind, "error");
  rmSync(ws, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
  console.log("manygit ok");
}

// Keep the original CI entry point running the action-context regressions too.
await import("./git-graph-context.mjs");
console.log("all tests passed");
