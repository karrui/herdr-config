// The jin.review daemon's review API (plans/fork/04 in the fork), signed in with the session the CLI keeps in ~/.pulls.review.
import { exec, home, readTextFile } from "herdr";

let state = null;

async function readState() {
  const text = await readTextFile(`${home()}/.pulls.review/daemon.pid`).catch(() => null);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** Starts the daemon when none answers: `-d --no-open` registers the worktree and opens nothing. */
async function connect(root, fresh) {
  if (state && !fresh) return state;
  state = await readState();
  if (state && await call(state, "GET", "/api/status").then(r => r.ok, () => false)) return state;
  const r = await exec("jin.review", ["-d", "--no-open", "--worktree"], { cwd: root }).catch(() => null);
  if (!r) throw new Error("jin.review isn't installed: bun add --global jin.review. See mods/README.md in github.com/JinJieBeWater/pulls.review.");
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `jin.review -d exited ${r.code}`);
  state = await readState();
  if (!state) throw new Error("The jin.review daemon didn't start");
  return state;
}

function call({ port, session }, method, path, body) {
  const origin = `http://127.0.0.1:${port}`;
  return fetch(origin + path, {
    method,
    headers: { Cookie: `pulls_session=${session}`, Origin: origin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Calls the daemon for the worktree at `root`; one that went away (restarted, a new session) is found again once. */
export async function request(root, method, path, body) {
  let r;
  try { r = await call(await connect(root), method, path, body); }
  catch { r = await call(await connect(root, true), method, path, body); }
  if (r.status === 401) r = await call(await connect(root, true), method, path, body);
  if (!r.ok) throw new Error((await r.text()).trim() || `jin.review answered ${r.status}`);
  return r.json();
}

/** POSTs to the review API, which names the worktree in the body. */
export const review = (root, path, body) => request(root, "POST", path, { path: root, ...body });
