// Makes a worktree on a new branch from the remote's latest default branch. Shared
// by the folders' new-space popup and the worktree dialog: mods can't import each
// other, so mods/worktree-hooks/fresh-worktree.js is a copy of this file. Change both.
// herdr's exec takes an argv list and never goes through a shell.
import { exec as execFile } from "herdr";

// `dirOf(branch)`: the folder for a branch's checkout. A name already taken (a branch
// here or on the remote, as of the fetch, or its folder) becomes "<name>-2", "-3", …
// The branch tracks nothing until it's pushed, so it isn't shown "behind" main.
// Returns { branch, dir }, or { error }.
export async function freshWorktree(repo, name, dirOf, on) {
  const run = (cmd, args) => execFile(cmd, args, { on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  const git = (args) => run("git", ["-C", repo, ...args]);
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const base = head.code === 0 ? head.stdout.trim() : null; // "origin/main"
  // Offline or signed out: from what was fetched last. No password prompt to hang on.
  if (base) await run("env", ["GIT_TERMINAL_PROMPT=0", "git", "-C", repo, "fetch", "--quiet", "origin", base.slice("origin/".length)]);
  const taken = async (b) => (await git(["show-ref", "--quiet", `refs/heads/${b}`, `refs/remotes/origin/${b}`])).code === 0
    || (await run("test", ["-e", dirOf(b)])).code === 0;
  let branch = name;
  for (let n = 2; await taken(branch); n++) branch = `${name}-${n}`;
  const dir = dirOf(branch);
  const r = await git(["worktree", "add", "--no-track", "-b", branch, dir, base ?? "HEAD"]);
  return r.code === 0 ? { branch, dir } : { error: r.stderr.trim().split("\n").pop() || "git worktree add failed." };
}
