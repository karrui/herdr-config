// Shared by changes-sandbox and tabs-sandbox; keep both copies identical.
import { exec as execFile } from "herdr";
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Include new files in Git's own line counts without changing the user's staging index.
export const WORKTREE_DIFF = `dir=$(mktemp -d) && trap 'rm -rf "$dir"' EXIT &&
index=$(git rev-parse --git-path index) &&
{ [ ! -f "$index" ] || cp "$index" "$dir/index"; } &&
GIT_INDEX_FILE="$dir/index" && export GIT_INDEX_FILE &&
git --no-optional-locks -c core.fsmonitor=false add --intent-to-add -- . &&
git --no-optional-locks -c core.fsmonitor=false diff --no-ext-diff --no-textconv "$@" --`;

export async function readCounts({ cwd, on }) {
  const top = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  const head = await execFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, on });
  const diff = await execFile("sh", ["-c", WORKTREE_DIFF, "changes", head.code === 0 ? "HEAD" : EMPTY_TREE, "--numstat", "-z", "--no-renames"], { cwd: root, on });
  if (diff.code !== 0) throw new Error(diff.stderr || "Couldn't count changes.");
  return diff.stdout.split("\0").reduce((totals, entry) => {
    const [add, del, ...file] = entry.split("\t");
    if (file.length) { totals.add += Number(add) || 0; totals.del += Number(del) || 0; totals.files++; }
    return totals;
  }, { add: 0, del: 0, files: 0 });
}
