// Exercise the execution path used by both dialogs and direct menu actions.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAction } from "../mods/git-graph/execute.js";

const repo = mkdtempSync(join(tmpdir(), "graph-action-context-"));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const calls = [];
const exec = async (program, args, options) => {
  assert.equal(program, "git");
  assert.equal(options.cwd, repo);
  assert.equal(options.on, "test-machine");
  calls.push(args);
  const result = spawnSync(program, args, { cwd: options.cwd, env, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const snapshot = () => ({ root: repo, on: "test-machine", head: git("rev-parse", "HEAD"),
  current: git("symbolic-ref", "--short", "HEAD"), remotes: [] });
try {
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "file"), "original");
  git("add", "file"); git("commit", "-qm", "initial");
  const first = snapshot();
  git("checkout", "-qb", "other");
  writeFileSync(join(repo, "file"), "unsaved");
  const reset = { type: "reset", hash: first.head, short: first.head.slice(0, 8) };
  const staleBranch = await executeAction(reset, { mode: "hard" }, first, exec);
  assert.equal(staleBranch.stale, true, "a branch change at the same commit invalidates the dialog");
  assert.equal(readFileSync(join(repo, "file"), "utf8"), "unsaved");
  assert.equal(calls.some((args) => args[0] === "reset"), false);

  const beforeCommit = snapshot();
  git("commit", "-qam", "next");
  const staleHead = await executeAction(reset, { mode: "hard" }, beforeCommit, exec);
  assert.equal(staleHead.stale, true, "a new commit on the same branch invalidates the dialog");
  assert.notEqual(git("rev-parse", "HEAD"), beforeCommit.head);

  const current = snapshot();
  assert.equal((await executeAction({ type: "createBranch", hash: current.head }, { name: "valid" }, current, exec)).ok, true);
  assert.equal(git("rev-parse", "valid"), current.head);
  git("checkout", "-q", "--detach", current.head);
  assert.equal((await executeAction({ type: "createBranch", hash: current.head }, { name: "detached" },
    { ...current, current: null }, exec)).ok, true);

  // Staging everything mid-conflict would commit the markers: refused, nothing run.
  git("checkout", "-q", "main"); git("checkout", "-qb", "side"); writeFileSync(join(repo, "file"), "side"); git("commit", "-qam", "side");
  git("checkout", "-q", "main"); writeFileSync(join(repo, "file"), "main"); git("commit", "-qam", "main");
  spawnSync("git", ["merge", "-q", "side"], { cwd: repo, env });
  calls.length = 0;
  const midMerge = snapshot(), conflict = await executeAction({ type: "commit" }, { message: "oops", all: true }, midMerge, exec);
  assert.match(conflict.message ?? "", /unresolved merge conflicts/);
  assert.equal(calls.some((args) => args[0] === "add" || args[0] === "commit"), false);
  assert.equal(git("rev-parse", "HEAD"), midMerge.head, "nothing committed");
  assert.equal((await executeAction({ type: "commit" }, { message: "oops", all: false }, midMerge, exec)).ok, false, "git itself refuses unmerged files");
  git("merge", "--abort");
  const fake = async (code, head = "", branch = "") => {
    const recorded = [];
    const out = await executeAction({ type: "checkout", name: "main" }, {},
      { root: repo, on: null, head: null, current: null }, async (_program, args) => {
        recorded.push(args);
        if (args.includes("rev-parse")) return { code, stdout: head };
        if (args.includes("symbolic-ref")) return { code, stdout: branch };
        return { code: 0, stdout: "" };
      });
    return { out, recorded };
  };
  assert.equal((await fake(1)).out.ok, true, "unborn/detached null snapshots compare correctly");
  const failed = await fake(128);
  assert.equal(failed.out.ok, false, "an unreadable repository must fail closed");
  assert.equal(failed.recorded.some((args) => args[0] === "checkout"), false);
  console.log("action context checks passed");
} finally {
  rmSync(repo, { recursive: true, force: true });
}
