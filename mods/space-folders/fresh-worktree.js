// Makes a worktree on a new branch from the remote's latest default branch. Shared
// by the folders' new-space popup and the worktree dialog: mods can't import each
// other, so mods/worktree-hooks/fresh-worktree.js is a copy of this file. Change both.
// herdr's exec takes an argv list and never goes through a shell.
import { exec as execFile } from "herdr";

// `dirOf(branch)`: the folder for a branch's checkout. A name already taken (by a
// branch here or on the remote, as of the fetch, or a folder) becomes "<name>-2", "-3", …
// The branch tracks nothing until it's pushed, so it isn't shown "behind" main.
// Returns { branch, dir }, or { error }.
export async function freshWorktree(repo, name, dirOf, on) {
  const run = (cmd, args) => execFile(cmd, args, { on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  const git = (args) => run("git", ["-C", repo, ...args]);
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const base = head.code === 0 ? head.stdout.trim() : null; // "origin/main"
  // Offline or signed out: from what was fetched last. No password prompt to hang on.
  if (base) await run("env", ["GIT_TERMINAL_PROMPT=0", "git", "-C", repo, "fetch", "--quiet", "origin", base.slice("origin/".length)]);
  // Git keeps branches as paths: "a" can't sit beside "a/b", either way round.
  const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"])).stdout
    .split("\n").filter(Boolean).map((r) => r.replace(/^refs\/(heads|remotes\/origin)\//, ""));
  const under = (b) => refs.some((r) => b.startsWith(`${r}/`));
  const taken = async (b) => under(b) || refs.some((r) => r === b || r.startsWith(`${b}/`))
    || (await run("test", ["-e", dirOf(b)])).code === 0;
  // Under a branch ("feat" for "feat/x") no suffix helps: "feat-x" instead.
  const stem = under(name) ? name.replaceAll("/", "-") : name;
  let branch = stem;
  for (let n = 2; await taken(branch); n++) {
    if (n > 99) return { error: `No free branch name like ${stem}.` };
    branch = `${stem}-${n}`;
  }
  const dir = dirOf(branch);
  const r = await git(["worktree", "add", "--no-track", "-b", branch, dir, base ?? "HEAD"]);
  return r.code === 0 ? { branch, dir } : { error: r.stderr.trim().split("\n").pop() || "git worktree add failed." };
}
