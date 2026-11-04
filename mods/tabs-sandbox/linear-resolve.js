// Finds the Linear ticket for a branch. Shared by the `linear` panel and the tab bar's
// Linear button: mods can't import each other, so mods/tabs-sandbox/linear-resolve.js
// is a copy of this file. Change both.
// herdr's exec takes an argv list and never goes through a shell.
import { exec as execFile, readTextFile, appHome, shared, setShared } from "herdr";

// The key lives in Herdr's folder, which sandboxed agents can't read.
export const KEY_DIR = () => `${appHome()}/data/linear`;
export const KEY_FILE = () => `${KEY_DIR()}/api-key`;
// Bumped when the panel saves a new key, so the tab bar reads it again.
export const KEY_CHANGED = "linear.key-changed";
// { "<repo>|<branch>": "DEVX-684" }; "" means unlinked on purpose (no auto-detect).
export const LINKS = "linear.links";
export const ID = /\b([a-z][a-z0-9]{0,9}-\d+)\b/gi;

// Links a ticket to a branch by hand; "" stops detecting one, null goes back to detecting.
export function setLink(repo, branch, value) {
  const links = { ...(shared(LINKS) ?? {}) }, k = `${repo}|${branch}`;
  if (value === null) delete links[k]; else links[k] = value;
  setShared(LINKS, links);
}

// The id in what was typed or pasted: a URL's follows /issue/ (its slug can look like
// one too: …/some-title-2), else the first one.
export function parseId(text) {
  const id = /\/issue\/([a-z][a-z0-9]{0,9}-\d+)/i.exec(text)?.[1] ?? [...text.matchAll(ID)][0]?.[1];
  return id ? id.toUpperCase() : null;
}

const ISSUE = `identifier title url description priorityLabel
  state { name color } assignee { name } project { name } labels { nodes { name color } }`;

export async function readKey() {
  return (await readTextFile(KEY_FILE()).catch(() => null))?.trim() || null;
}

export async function linear(apiKey, query, variables) {
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Linear rejected the API key"), { auth: true });
  const body = await r.json().catch(() => null);
  if (!r.ok || body?.errors?.length) throw new Error(body?.errors?.[0]?.message ?? `Linear answered ${r.status}`);
  return body.data;
}

const byId = async (apiKey, id) => (await linear(apiKey, `query($id: String!) { issue(id: $id) { ${ISSUE} } }`, { id })).issue;

// The workspace's team keys, asked once per key.
const teams = new Map();
async function teamKeys(apiKey) {
  if (!teams.has(apiKey)) teams.set(apiKey, new Set((await linear(apiKey, "{ teams(first: 250) { nodes { key } } }")).teams.nodes.map((t) => t.key.toUpperCase())));
  return teams.get(apiKey);
}

// The ticket for the branch checked out in `cwd`: linked by hand, else the one an agent
// set in git config (`git config branch.<branch>.linear DEVX-684`: agent/instructions.md
// asks them to, and a sandboxed one can write it), else an id in the branch whose prefix is a team (devx-684-fix → DEVX-684), else the issue Linear ties to
// that branch name (ones it suggested, and ones it saw in PRs).
// Resolves { status: "no-repo" | "no-branch" | "issue" | "unlinked" | "not-found", repo, branch, issue,
// source: "linked" | "agent" | "branch" }.
export async function findTicket(apiKey, { cwd, branch, on }) {
  const common = await execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
  if (common.code !== 0) return { status: "no-repo" };
  if (!branch) return { status: "no-branch" };
  const repo = common.stdout.trim().replace(/\/\.git$/, "");
  const linked = (shared(LINKS) ?? {})[`${repo}|${branch}`];
  const done = (issue, source) => ({ status: issue ? "issue" : linked === "" ? "unlinked" : "not-found", repo, branch, issue, source });
  if (linked) return done(await byId(apiKey, linked), "linked");
  if (linked === "") return done(null, null);
  const set = await execFile("git", ["config", "--get", `branch.${branch}.linear`], { cwd, on });
  const agent = set.code === 0 ? parseId(set.stdout) : null;
  if (agent) return done(await byId(apiKey, agent), "agent");
  const known = await teamKeys(apiKey);
  for (const [, id] of branch.matchAll(ID)) {
    if (!known.has(id.split("-")[0].toUpperCase())) continue;
    const issue = await byId(apiKey, id.toUpperCase()).catch(() => null);
    if (issue) return done(issue, "branch");
  }
  const found = (await linear(apiKey, `query($b: String!) { issueVcsBranchSearch(branchName: $b) { ${ISSUE} } }`, { b: branch })).issueVcsBranchSearch;
  return done(found, "branch");
}
