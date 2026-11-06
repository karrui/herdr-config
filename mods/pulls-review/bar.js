// Modified for herdr-config: resolve parked chat terminals and show added/removed line totals.
// The Review bar: the focused worktree's uncommitted files and its commits ahead of and behind
// its upstream, each opening that diff.
// Its logo lists what else there is to pick: a commit, or another branch.
// The counts read the remote-tracking refs as they are; fetching is left to you.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Popup } from "gpui-base";
import { spaces, panes, terminals, focused, exec, watchFolder, window, openOverlay, closeOverlay, props, setShared, shared, theme, settings, home } from "herdr";
import { launch } from "./open.js";
import { detailsFor, detailsLine, detailsCard } from "./details.js";
import { tip } from "./tip.js";

const MOD = "pulls-review";
// A conventional commit's type and scope (`fix(t3-tabs): `), dimmed so the words after it lead.
const PREFIX = /^[a-z]+(\([^)]*\))?!?: /;
// When the logo's menu last closed: a press outside a popup closes it before the press's own click lands.
const MENU_CLOSED = `${MOD}.menuClosed`;
export const menuClosed = () => setShared(MENU_CLOSED, Date.now());

// The hovered button, as state: its hover label reads it.
const glow = (view, id) => (on, cx) => {
  if (on) view.hot = id;
  else if (view.hot === id) view.hot = null;
  cx.notify();
};
// A menu hangs from the bar (40px, as Herdr T3's tab bar) under the click, not on the pointer, where it would cover the
// bar; the app keeps it in the window. With no press to read (assistive tech clicks without one), the app's default: the pointer.
const underBar = (press) => press && { x: press.x - 8, y: 40 * settings().zoom };

// The shipped `changes` mod's lookup, except for a mod pane (below).
export function reviewLocation() {
  const space = spaces().find((s) => s.active), f = focused();
  const ps = panes(), pane = f?.pane ? ps.find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A mod pane has no folder. The review pane says which repository it shows; for another, its tab's terminals stand in.
  const reviewed = pane?.mod === "review" ? shared("review.shown")?.[pane.tab]?.root : null;
  const terminal = pane?.mod === "chat" ? terminals().find(t => t.state === "live" && t.labels?.["herdr.chat"] === pane.pane) : null;
  const beside = pane && !pane.cwd ? ps.find(p => p.tab === pane.tab && p.cwd)?.cwd : null;
  return { cwd: reviewed || terminal?.foreground?.cwd || terminal?.cwd || pane?.cwd || beside || f?.cwd || space?.folder, on };
}

// Reads write nothing under .git, so the folder watch doesn't wake on them.
export const git = (cwd, args) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd });

// A commit's age as the Inbox's settled rows read (t3-inbox's ago), but "now" for "just now": the column is narrow.
function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// A commit's card: its age, then when to the minute (`2h ago · Nov 5, 10:37`).
function when(ms, now) {
  const d = new Date(ms), short = ago(ms, now), pad = (n) => String(n).padStart(2, "0");
  return `${short === "now" ? "just now" : `${short} ago`} · ${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const browserPath = page => encodeURI(page).replaceAll("#", "%23");

// The page the CLI opens for `args` (its pageFor), `branch` standing in for its default-branch lookup: what the bar knows without git.
export const argPage = (args, branch) => browserPath(args[0] === "--worktree" ? "/worktree"
  : args[0] ? `/${args[0].includes("...") ? "compare" : "commit"}/${args[0]}` : `/branch/${branch}`);

// Worth a read? Of Git's own files only HEAD and refs, and nothing Git ignores: macOS reports those too.
async function touchesDiff(root, paths) {
  if (paths.some(p => /\/\.git\/(HEAD|refs\/)/.test(p))) return true;
  const files = paths.filter(p => !/\/\.git(\/|$)/.test(p));
  if (!files.length) return false;
  // check-ignore: 0 some ignored and listed, 1 none, 128 can't judge.
  const r = await git(root, ["check-ignore", "--", ...files]).catch(() => null);
  return r?.code !== 0 || r.stdout.trim().split("\n").length < files.length;
}

// Each location keeps its last read, so switching back shows it at once and switching away never shows the old one.
// Focus is checked every 250 ms (memory reads only); git is read on a new location, a change in the worktree (a second
// after the last read at the soonest), else every 10 s.
export function watchReview(view, cx) {
  view.reviews = new Map();
  view.reviewAt = new Map();
  view.reviewBusy = new Set();
  view.reviewWatching = new Set();
  cx.timer.every(250, (cx) => {
    const where = reviewLocation(), key = JSON.stringify(where);
    if (key !== view.reviewKey) { view.reviewKey = key; cx.notify(); }
    if (!window()?.active || view.reviewBusy.has(key) || Date.now() - (view.reviewAt.get(key) ?? 0) < 10000) return;
    view.reviewBusy.add(key);
    view.reviewAt.set(key, Date.now());
    cx.spawn(async (cx) => {
      try {
        const review = where.cwd && !where.on ? await readReview(where.cwd) : null;
        view.reviews.set(key, review);
        // One watch per repo: focus moving A → B → A before A changes keeps A's first watch.
        const root = review?.root;
        if (root && !view.reviewWatching.has(root)) {
          view.reviewWatching.add(root);
          cx.spawn(async () => {
            try {
              while (view.reviews.get(view.reviewKey)?.root === root) {
                const paths = await watchFolder(root);
                if (await touchesDiff(root, paths)) for (const [k, at] of view.reviewAt) view.reviewAt.set(k, Math.min(at, Date.now() - 9000));
              }
            }
            catch {} // The next read watches it again.
            finally { view.reviewWatching.delete(root); }
          });
        }
      } catch { view.reviews.set(key, null); }
      finally { view.reviewBusy.delete(key); cx.notify(); }
    });
  });
}

// Match jin.review's worktreeDiff: new files are intent-to-add in a disposable index.
const WORKTREE_STATS = `dir=$(mktemp -d) && trap 'rm -rf "$dir"' EXIT &&
index=$(git rev-parse --git-path index) &&
{ [ ! -f "$index" ] || cp "$index" "$dir/index"; } &&
GIT_INDEX_FILE="$dir/index" && export GIT_INDEX_FILE &&
git --no-optional-locks -c core.fsmonitor=false add --intent-to-add -- . &&
git --no-optional-locks -c core.fsmonitor=false diff --no-ext-diff --no-textconv --numstat "$1" --`;

async function lineStats(root, base, worktree = false) {
  const r = worktree ? await exec("sh", ["-c", WORKTREE_STATS, "stats", base], { cwd: root })
    : await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", base, "--"]);
  if (r.code !== 0) return null;
  return r.stdout.trim().split("\n").reduce((totals, line) => {
    const [add, del] = line.split("\t");
    totals.add += Number(add) || 0; totals.del += Number(del) || 0;
    return totals;
  }, { add: 0, del: 0 });
}

async function readReview(cwd) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  // File by file, as the page it opens lists them: plain status folds a new folder into one line.
  const root = top.stdout.trim(), status = await git(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
  if (status.code !== 0) return null;
  const review = { root, branch: null, upstream: null, base: null, baseRef: null, changed: 0, ahead: 0, behind: 0, unmerged: 0, newer: 0, gone: false };
  let ab = false;
  for (const line of status.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) review.branch = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) review.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) { ab = true; [review.ahead, review.behind] = line.slice(12).split(" ").map(n => Math.abs(parseInt(n, 10)) || 0); }
    else if (line && !line.startsWith("#")) review.changed++; // One line per file, staged or not, renames included.
  }
  // git leaves out branch.ab when the upstream is set but gone, as after a merged PR's branch is deleted.
  review.gone = Boolean(review.upstream) && !ab;
  // The default branch as the CLI resolves it (resolveDefaultBranch): origin/HEAD, else main or master.
  const originHead = (await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])).stdout.trim();
  const names = originHead ? [originHead.replace(/^origin\//, "")] : ["main", "master"];
  for (const ref of names.flatMap(name => [`origin/${name}`, name])) {
    const count = await git(root, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
    if (count.code !== 0) continue; // No such ref.
    // `base` is the branch name; `baseRef` is what was compared, named in the label so a fork's stale origin/main reads as itself.
    review.base = ref.replace(/^origin\//, "");
    review.baseRef = ref;
    // On the default branch or a detached HEAD the CLI opens its ref picker instead: nothing to show.
    if (review.branch !== review.base && review.branch !== "(detached)") {
      [review.newer, review.unmerged] = count.stdout.trim().split(/\s+/).map(n => parseInt(n, 10) || 0);
      // A branch tracking the default branch: its ↑ is the same commits as N ahead of base.
      if (review.upstream === `origin/${review.base}`) review.ahead = 0;
    }
    break;
  }
  const head = status.stdout.includes("# branch.oid (initial)") ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904" : "HEAD";
  review.worktreeStats = review.changed ? await lineStats(root, head, true) : null;
  review.branchStats = review.unmerged ? await lineStats(root, `${review.baseRef}...HEAD`) : null;
  return review;
}

// Read on click, so the bar's 10 s poll stays as cheap as it was.
// shortcut: the menu holds the newest 200 commits and 20 branches, so search can't reach past them; read more if a repo needs it.
// `log` false inside a review: the menu lists the review's commits.
// `unpushed`: the shas not on the upstream, for the menu's ↑.
async function readPicks(r, log) {
  const none = { code: 0, stdout: "" };
  const [read, ahead] = await Promise.all([
    log ? git(r.root, ["log", "-200", "--format=%H%x1f%s%x1f%ct%x1f%an", r.unmerged ? `${r.baseRef}..HEAD` : "HEAD"]) : none,
    // Inside a review the commits may be another branch's, which HEAD's upstream says nothing about.
    log && r.upstream && !r.gone ? git(r.root, ["rev-list", "--max-count=200", `${r.upstream}..HEAD`]) : none,
  ]);
  const commits = read.stdout.split("\n").filter(Boolean).map(line => { const [sha, subject, time, author] = line.split("\x1f"); return { sha, subject, time: Number(time) * 1000, author }; });
  const unpushed = ahead.code === 0 ? ahead.stdout.split("\n").filter(Boolean) : [];
  if (!r.baseRef) return { commits, branches: [], unpushed };
  // Each branch's last commit, upstream and worktree, and how far it is ahead of and behind the base, in the same call.
  // %(ahead-behind) is Git 2.41's: an older Git fails it, and the menu goes without counts.
  const fields = "%(refname:short)%1f%(contents:subject)%1f%(committerdate:unix)%1f%(authorname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(worktreepath)";
  const refs = (format) => git(r.root, ["for-each-ref", "--sort=-committerdate", "--count=21", `--no-merged=${r.baseRef}`, `--format=${format}`, "refs/heads"]);
  let listed = await refs(`${fields}%1f%(ahead-behind:${r.baseRef})`);
  if (listed.code !== 0) listed = await refs(fields);
  const branches = listed.stdout.split("\n").map(line => line.split("\x1f")).filter(([name]) => name && name !== r.branch).slice(0, 20)
    .map(([name, subject, time, author, upstream, track, worktree, ab]) => {
      const [count, behind] = (ab ?? "").split(" ").map(n => parseInt(n, 10) || 0);
      return { name, subject, time: Number(time) * 1000, author, upstream, track, worktree, ...(ab === undefined ? {} : { count, behind }) };
    });
  return { commits, branches, unpushed };
}

const branchArgs = (b) => [`${props().baseRef}...${b.name}`];
// No analysis here: browsing the menu's commits mustn't start and bill one per click. The menu closes once it's open:
// closing it first would stop this task.
const openPick = (args, cx) => cx.spawn(() => launch({ root: props().root, args, page: argPage(args), overlay: props().overlay }));

// Another page of the diff the review pane shows: a request as open.js's, with the base that keeps that diff's commits.
const showPage = ({ tab, root, base }, page) => {
  const selections = shared("review.sidebar"), previous = selections?.[tab];
  const request = { tab, root, page, base, n: Math.max(Date.now(), (previous?.n ?? 0) + 1) };
  if (previous) setShared("review.sidebar", { ...selections, [tab]: request });
  else setShared("review", request);
};
const showWithin = (page) => { closeOverlay(props().overlay); showPage(props().within, page); };
const pickCommit = (c, cx) => (props().within ? showWithin(`/commit/${c.sha}`) : openPick([c.sha], cx));

function reviewMatches(view) {
  const query = view.search.value().trim().toLowerCase(), { commits, branches } = props();
  return {
    commits: commits.filter(c => c.sha.startsWith(query) || c.subject.toLowerCase().includes(query)),
    branches: branches.filter(b => b.name.toLowerCase().includes(query) || (b.subject ?? "").toLowerCase().includes(query)),
  };
}

export function initReviewMenu(view) {
  view.search = InputState.new({ placeholder: props().branches.length ? "Search commits and branches" : "Search commits" });
  view.at = 0;
  view.tab = props().commits.length || props().within ? "commits" : "branches";
  view.search.on("change", (_e, cx) => {
    // A search that empties the page shown and not the other turns to the other.
    const m = reviewMatches(view), other = view.tab === "commits" ? "branches" : "commits";
    if (!m[view.tab].length && m[other].length && !(view.tab === "commits" && props().within && !view.search.value().trim())) view.tab = other;
    view.at = 0; view.scrollTop = {}; view.hovered = null; detailsFor(view, null, cx); cx.notify();
  });
  view.search.on("submit", (_e, cx) => menuPicks(view)[view.at]?.act(cx));
  view.search.focus();
}

// The menu's rows in order, each with what it opens: the highlight walks them, as the Actions and New menus'.
function menuPicks(view) {
  const { commits, branches } = reviewMatches(view), { within } = props();
  if (view.tab === "branches") return branches.map(b => ({ id: `review-branch-${b.name}`, act: (cx) => openPick(branchArgs(b), cx) }));
  return [
    // All changes until a search hides it.
    ...(within && !view.search.value().trim() ? [{ id: "review-all", act: () => showWithin(within.base) }] : []),
    ...commits.map(c => ({ id: `review-commit-${c.sha}`, act: (cx) => pickCommit(c, cx) })),
  ];
}

// Commits and branches are two pages of the menu, so the two never read as one list; Tab or a click turns between them.
const menuTabs = () => props().branches.length > 0 && (props().commits.length > 0 || Boolean(props().within));
function setTab(view, tab, cx) {
  view.tab = tab; view.at = 0; view.hovered = null;
  detailsFor(view, null, cx);
  cx.notify();
}

// The logo's menu, this mod opened as an overlay with props.menu (main.js).
export function reviewMenu(view) {
  const t = theme(), { base, branch, height, within, upstream, unpushed = [] } = props(), { commits, branches } = reviewMatches(view), searching = Boolean(view.search.value().trim());
  const now = Date.now(), picks = menuPicks(view), lit = picks[view.at]?.id;
  // The card follows the highlight, by pointer or key: a commit's opens, anything else's closes it.
  const highlight = (at, cx) => {
    view.at = at;
    const id = picks[at].id;
    detailsFor(view, /^review-(commit|branch)-/.test(id) ? id : null, cx);
    cx.notify();
  };
  const title = (text) => div().h(24).px(8).flex_none().flex().items_center().text_size(11).text_color(t.dim).child(text);
  const tabs = menuTabs(), tab = view.tab, scope = tab === "branches" ? `vs ${base}` : within ? "in this review" : branch === "(detached)" ? "" : `on ${branch}`;
  const segment = (id, label, n) => h_flex().id(`review-tab-${id}`).h(26).px(10).gap(6).flex_none().items_center().rounded(6).text_size(12)
    .when(id === tab, el => el.bg(t.selected).text_color(t.foreground)).when(id !== tab, el => el.text_color(t.dim).hover(s => s.bg(t.foreground + "0a")))
    .role("button").accessibility_label(`${label}, ${n}${id === tab ? ", shown" : ""}`).on_click((_e, cx) => setTab(view, id, cx))
    .child(label).child(div().text_color(t.dim).child(String(n)));
  // As the Actions and New menus: the highlighted row `selected`, set by the pointer or ↑/↓, the others lifted faintly on hover.
  const row = (id, name, action, cells) => h_flex().id(id).h(32).px(8).gap(8).flex_none().items_center().rounded(6).text_color(t.foreground)
    .when(id === lit, el => el.bg(t.selected)).when(id !== lit, el => el.hover(s => s.bg(t.foreground + "0a")))
    .on_hover((on, cx) => {
      if (on) { view.hovered = id; highlight(picks.findIndex(p => p.id === id), cx); }
      else if (view.hovered === id) { view.hovered = null; detailsFor(view, null, cx); cx.notify(); }
    })
    .role("button").accessibility_label(name).on_click(action).children(cells);
  // What the review pane shows, as a menu marks its pick.
  const shown = () => svg("mods/pulls-review/check.svg").size(14).flex_none().text_color(t.muted);
  // A popup's height is only a maximum: this one sets its own, for the list to scroll inside and to hold still while searching.
  return v_flex().id("review-menu").w_full().h(height).p(5).bg(t.popover).text_size(13)
    .on_key_down((e, cx) => {
      if (e.key === "tab" && tabs) { setTab(view, tab === "commits" ? "branches" : "commits", cx); cx.stop_propagation(); return; }
      if ((e.key !== "down" && e.key !== "up") || !picks.length) return;
      view.hovered = null;
      highlight((view.at + (e.key === "down" ? 1 : picks.length - 1)) % picks.length, cx);
      cx.stop_propagation();
    })
    .child(h_flex().h(32).mb(4).px(8).gap(8).flex_none().items_center()
      .child(svg(`mods/${MOD}/search.svg`).size(13).flex_none().text_color(t.dim))
      .child(Input.new(view.search).flex_1().h_full().text_size(13).text_color(t.foreground)))
    // Outside the list, so the pages' switch and All changes stay put.
    .when(tabs, el => el.child(h_flex().h(32).mb(4).px(3).gap(4).flex_none().items_center()
      .child(segment("commits", "Commits", commits.length)).child(segment("branches", "Branches", branches.length))
      .child(div().flex_1()).child(div().min_w(0).truncate().pr(5).text_size(11).text_color(t.dim).child(scope))))
    .when(!tabs, el => el.child(title(tab === "branches" ? `Branches vs ${base}` : within ? "Commits in this review" : branch === "(detached)" ? "Commits" : `Commits on ${branch}`)))
    .when(tab === "commits" && Boolean(within) && !searching, el => el.child(row("review-all", "Review all changes" + (within.sha ? "" : ", shown"), () => showWithin(within.base), [div().flex_1().child("All changes"), ...(within.sha ? [] : [shown()])])))
    .when(tab === "branches", el => el.child(scrollList(view, "review-branches", branches.map(b => {
      const id = `review-branch-${b.name}`;
      return { id, el: row(id, `Review branch ${b.name}` + (b.count === undefined ? "" : `, ${b.count} ahead of ${base}`), (_e, cx) => openPick(branchArgs(b), cx), [
        svg("mods/pulls-review/git-branch.svg").size(13).flex_none().text_color(t.dim),
        h_flex().flex_1().min_w(0).gap(8)
          .child(div().flex_none().max_w(220).truncate().child(b.name))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(b.subject ?? "")),
        h_flex().flex_none().gap(6).items_center().text_size(12).text_color(t.dim)
          .when(b.count !== undefined, el => el.child(`${b.count} ahead`))
          .child(b.time ? ago(b.time, now) : ""),
        branchCard(view, t, id, b, base, now)]) };
    }), picks, lit).flex_1().min_h(0)))
    .when(tab === "commits", el => el.child(scrollList(view, "review-commit-list", commits.map(c => {
        const id = `review-commit-${c.sha}`, prefix = PREFIX.exec(c.subject)?.[0] ?? "", out = unpushed.includes(c.sha), on = c.sha === within?.sha;
        const r = row(id, `Review commit ${c.subject}` + (out ? ", not pushed" : "") + (on ? ", shown" : ""), (_e, cx) => pickCommit(c, cx), [
          h_flex().flex_1().min_w(0).gap(4).when(Boolean(prefix), el => el.child(div().flex_none().text_color(t.dim).child(prefix.trim())))
            .child(div().flex_1().min_w(0).truncate().child(c.subject.slice(prefix.length))),
          h_flex().flex_none().gap(6).items_center().text_size(12).text_color(t.dim)
            .when(out, el => el.child(div().text_color(t.ansi2).child("↑")))
            .child(c.time ? ago(c.time, now) : "")
            .when(on, el => el.child(shown())),
          commitCard(view, t, id, c, upstream, out, now)]);
        return { id, el: r };
      }), picks, lit).flex_1().min_h(0)))
    .when(!picks.length, el => el.child(div().p(8).text_color(t.dim).child("No matches")));
}

// A list scrolled by script, as the shipped picker's: its rows keep their handlers, which a virtual list's can't (a hovered
// commit opens its card), and ↑/↓ keep the highlight in view, which a scroll area can't be told to. Rows are 32px, only those
// in view drawn, where the scroll puts them. `items`: [{ id, el }]; the caller sizes the list.
function scrollList(view, id, items, picks, lit) {
  const height = view.listHeight?.[id], total = items.length * 32, max = height === undefined ? 0 : Math.max(0, total - height);
  let top = Math.max(0, Math.min(view.scrollTop?.[id] ?? 0, max));
  const at = items.findIndex(x => x.id === lit);
  if (at >= 0 && height !== undefined) top = Math.max(0, Math.min(top, at * 32, max), (at + 1) * 32 - height);
  view.scrollTop = { ...view.scrollTop, [id]: top };
  const shown = (i) => height === undefined || (i * 32 + 32 > top && i * 32 < top + height);
  return div().id(id).relative().overflow_hidden()
    .on_size_change((size, cx) => {
      const h = size.height / (Number(settings()?.zoom) || 1);
      if (h !== height) { view.listHeight = { ...view.listHeight, [id]: h }; cx.notify(); }
    })
    // From the scroll as it is now: a trackpad sends several events between two renders.
    .on_scroll_wheel((e, cx) => {
      const from = view.scrollTop[id], next = Math.max(0, Math.min(from - e.delta.y / (Number(settings()?.zoom) || 1), max));
      if (next === from) return;
      view.scrollTop = { ...view.scrollTop, [id]: next };
      // The highlight goes along to the nearest row in view, so the next frame doesn't scroll back to it; a card moves off.
      const now = items.findIndex(x => x.id === picks[view.at]?.id);
      if (now >= 0) {
        const keep = Math.min(Math.max(now, Math.ceil(next / 32)), Math.floor((next + height) / 32) - 1);
        view.at = picks.findIndex(p => p.id === items[keep].id);
      }
      view.hovered = null;
      detailsFor(view, null, cx);
      cx.stop_propagation();
      cx.notify();
    })
    .children(items.map((x, i) => (shown(i) ? x.el.absolute().left(0).right(0).top(i * 32 - top) : null)).filter(Boolean));
}

// As an Inbox row's details, but on the row's left: the menu hangs at the window's right. A 1px anchor just outside the
// row's top left corner, the card's top right pinned to it. The whole subject, which the row truncates, then its lines.
const initial = (t, name) => div().size(12).flex_none().rounded_full().bg(t.border).flex().items_center().justify_center()
  .text_size(8).font_medium().text_color(t.muted).child(name.slice(0, 1).toUpperCase());

function commitCard(view, t, id, c, upstream, out, now) {
  const up = view.details === id || view.detailsOut === id;
  return Popup.new(`details-${id}`, div()).absolute().top(-1).left(-1).size(1).anchor("top_right")
    .when(up, pop => pop.content(detailsCard(view, t, id, c.subject, [
      c.time && detailsLine(t, svg("mods/pulls-review/clock.svg").size(12).flex_none().text_color(t.muted), when(c.time, now)),
      c.author && detailsLine(t, initial(t, c.author), c.author),
      upstream && detailsLine(t, svg("mods/pulls-review/git-branch.svg").size(12).flex_none().text_color(out ? t.ansi2 : t.muted), out ? `Not on ${upstream} yet` : `On ${upstream}`),
    ], true).mr(4)));
}

// A branch's card, as a commit's: its last commit, then how it stands against the base and its upstream, and where it's checked out.
function branchCard(view, t, id, b, base, now) {
  const up = view.details === id || view.detailsOut === id, icon = (name, color = t.muted) => svg(`mods/pulls-review/${name}.svg`).size(12).flex_none().text_color(color);
  const ahead = /ahead (\d+)/.exec(b.track ?? "")?.[1], behind = /behind (\d+)/.exec(b.track ?? "")?.[1];
  const upstream = !b.upstream ? "No upstream" : b.track === "gone" ? `${b.upstream} is gone`
    : !ahead && !behind ? `Up to date with ${b.upstream}` : `${[ahead && `${ahead} not pushed`, behind && `${behind} to pull`].filter(Boolean).join(", ")} · ${b.upstream}`;
  const h = home?.() ?? "";
  return Popup.new(`details-${id}`, div()).absolute().top(-1).left(-1).size(1).anchor("top_right")
    .when(up, pop => pop.content(detailsCard(view, t, id, b.name, [
      b.subject && detailsLine(t, icon("file-text"), b.subject),
      b.time && detailsLine(t, icon("clock"), when(b.time, now)),
      b.author && detailsLine(t, initial(t, b.author), b.author),
      b.count !== undefined && detailsLine(t, icon("git-compare"), `${b.count} ahead of ${base}${b.behind ? `, ${b.behind} behind` : ""}`),
      detailsLine(t, icon("git-branch", ahead ? t.ansi2 : t.muted), upstream),
      b.worktree && detailsLine(t, icon("folder"), `Checked out in ${h && b.worktree.startsWith(h) ? "~" + b.worktree.slice(h.length) : b.worktree}`),
    ], true).mr(4)));
}

export function reviewBar(view, t, stop) {
  // Looked up on each render, so the frame that shows another space already shows its own counts.
  const r = view.reviews?.get(JSON.stringify(reviewLocation()));
  if (!r) return null;
  const n = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  // A narrow bar's layout sets it (Herdr T3's bar-measure): the counts alone, their colors telling them apart. Unset, the words too.
  const compact = shared("bar.compact");
  // What the focused tab's review pane shows, when it's this repository's; `sha`, when that's one commit of its diff.
  const tab = focused()?.tab, reviewed = shared("review.sidebarShown")?.[tab] ?? shared("review.shown")?.[tab], here = reviewed?.root === r.root ? reviewed : null;
  const sha = here?.page?.startsWith("/commit/") && here.page !== here.base ? here.page.slice("/commit/".length) : null;
  const list = here?.commits ?? [], index = sha ? list.findIndex(c => c.sha === sha) : -1;
  const within = here && (sha || list.length > 1) ? { tab, root: r.root, base: here.base, sha } : null;
  const isShown = (args) => here?.base === argPage(args, r.branch);
  // The accessibility label says what each count compares, which the short label can't.
  // The count carries the color; what it counts stays quiet beside it.
  // 22, the outline's inside: a hover card's wrapper has no height for h_full to fill. Its label is the name's first part.
  // Compact, the label gives back the words the count lost, `· merged?` included.
  const item = ([id, count, noun, ansi, name, args, stats], last) => tip(view.reviewHover, t, id, compact && noun ? `${count} ${noun}` : name.split(": ")[0], h_flex().id(id).h(22).px(8).gap(6).flex_none().items_center()
    .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).role("button").accessibility_label(isShown(args) ? `${name}, shown` : name).when(isShown(args), el => el.bg(t.hover).text_color(t.foreground))
    // Herdr has no group hover. Entering the next segment can report before leaving this one.
    .on_hover((on, cx) => { if (on) view.reviewHover = id; else if (view.reviewHover === id) view.reviewHover = null; cx.notify(); })
    .on_click((_e, cx) => cx.spawn(() => launch({ root: r.root, args, page: argPage(args, r.branch) })))
    // Hovered, the label turns foreground: the count takes its bright twin (ansi + 8) to stay the lead, same hue.
    .child(div().font_medium().text_color(t[`ansi${view.reviewHover === id ? ansi + 8 : ansi}`]).child(count))
    .when(Boolean(noun) && !compact, el => el.child(noun))
    .when(Boolean(stats), el => el.child(div().text_color(t.ansi2).child(`+${stats.add}`)).child(div().text_color(t.ansi1).child(`−${stats.del}`)))
    .when(last, el => el.rounded_r(6)), { below: true });
  const segments = [
    // A squash merge leaves the count standing, so a deleted upstream is the visible hint it may be done.
    r.unmerged > 0 && ["review-open", String(r.unmerged), `ahead of ${r.base}${r.gone ? " · merged?" : ""}`, 4, `Review the branch: ${n(r.unmerged, "commit")} on ${r.branch}, not on ${r.baseRef}`
      + (r.newer ? ` · ${r.baseRef} has ${n(r.newer, "newer commit")}` : "") + (r.gone ? ` · ${r.upstream} is gone, likely merged` : ""), [], r.branchStats],
    r.changed > 0 && ["review-changes", String(r.changed), "uncommitted", 3, `Review ${n(r.changed, "uncommitted file")}: staged, unstaged and new`, ["--worktree"], r.worktreeStats],
    r.ahead > 0 && ["review-ahead", `↑${r.ahead}`, null, 2, `Review ${n(r.ahead, "commit")} to push: on ${r.branch}, not on ${r.upstream}`, [`${r.upstream}...${r.branch}`]],
    r.behind > 0 && ["review-behind", `↓${r.behind}`, null, 1, `Review ${n(r.behind, "commit")} to pull: on ${r.upstream} as of your last fetch, not on ${r.branch}`, [`${r.branch}...${r.upstream}`]],
  ].filter(Boolean);
  const pressed = (e, cx) => { view.reviewPress = e.position; view.pressAt = Date.now(); stop(e, cx); };
  const openMenu = (_e, cx) => {
    view.hot = null; cx.notify();
    // The button toggles: the press that brought this click closed the menu, so the click leaves it closed. 50 ms, for
    // a close reported just before the press. No press (assistive tech clicks without one), nothing to tell.
    const closing = view.pressAt != null && (shared(MENU_CLOSED) ?? 0) >= view.pressAt - 50;
    view.pressAt = null;
    if (closing || view.readingPicks) return;
    view.readingPicks = true;
    cx.spawn(async () => { try {
      const picks = await readPicks(r, !within), { branches, unpushed } = picks;
      // Within a review, its own commits, newest first as the log's.
      const commits = within ? [...list].reverse() : picks.commits;
      if (!commits.length && !branches.length) return;
      // Tall enough for the longer page, so turning pages doesn't resize it; one page alone has a title instead of the switch.
      const tabs = branches.length > 0 && (commits.length > 0 || Boolean(within)), mine = commits.length + (within ? 1 : 0);
      const height = Math.min(480, 10 + 36 + (tabs ? 36 : 24) + (tabs ? Math.max(mine, branches.length) : mine + branches.length) * 32);
      openOverlay({ mod: MOD, kind: "popup", at: underBar(view.reviewPress), width: 560, height, props: { menu: "review", root: r.root, branch: r.branch, base: r.base, baseRef: r.baseRef, upstream: within || r.gone ? null : r.upstream, commits, branches, unpushed, height, within } });
    } finally { view.readingPicks = false; } });
  };
  // One commit shown: its place, opening the menu, between steps to the older and newer ones.
  const step = (id, glyph, label, commit, last) => h_flex().id(id).h(22).px(6).flex_none().items_center().text_size(12).text_color(commit ? t.dim : t.border).role("button").accessibility_label(label)
    .when(Boolean(commit), el => el.hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => showPage(within, `/commit/${commit.sha}`)))
    .when(Boolean(last), el => el.rounded_r(6)).child(glyph);
  const place = !sha ? [] : [div().w(1).h(14).flex_none().bg(t.border),
    step("commit-older", "‹", "Older commit", index > 0 && list[index - 1]),
    h_flex().id("review-commits").h(22).px(2).flex_none().items_center().text_size(12).text_color(t.foreground).hover(s => s.bg(t.hover)).role("button").accessibility_label("Pick another commit of this review")
      .on_mouse_down("left", pressed).on_click(openMenu)
      .child(index === -1 ? sha.slice(0, 7) : compact ? `${index + 1}/${list.length}` : `Commit ${index + 1} of ${list.length}`),
    step("commit-newer", "›", "Newer commit", index >= 0 && list[index + 1], true)];
  // Outlined, not filled: a fill would read as an active tab. Each part's fill runs to the outline and the rules.
  return h_flex().id("pulls-review").h(24).flex_none().items_center().rounded(6).border(1).border_color(t.border).on_mouse_down("left", stop)
    // Stays with no counts: on a clean default branch it's the only way in.
    .child(tip(view.hot, t, "review-pick", "Change what to review", h_flex().id("review-pick").h(22).px(5).flex_none().items_center().rounded_l(6).when(!segments.length && !sha, el => el.rounded_r(6))
      .hover(s => s.bg(t.hover)).on_hover(glow(view, "review-pick")).role("button").accessibility_label("Change what to review")
      .on_mouse_down("left", pressed).on_click(openMenu)
      // image, not svg: svg would draw the logo in one tint.
      .child(image(`mods/${MOD}/logo.svg`).w(14).h(14).flex_none()), { below: true }))
    .children(segments.flatMap((s, i) => [div().w(1).h(14).flex_none().bg(t.border), item(s, !sha && i === segments.length - 1)]))
    .children(place);
}
