// What the pane's diff list shows, as plain data: no gpui here, so check-pane.cjs runs it under node.
// The daemon sends each hunk's rows already highlighted (plans/fork/04 in the jin.review fork).

// Heights on one scale: 20 a code line, 24 a hunk, 28 a group, 32 a file.
export const ROW = 20, HUNK = 24, GROUP = 28, FILE = 32, NOTE_LINE = 18;
// One column of 12px JetBrains Mono; past MAX_COLUMNS a line is cut, not scrolled to.
export const CHAR = 7.25, MAX_COLUMNS = 1000;
// Code lines go to the list in runs of up to this many, one item each: Herdr's v_virtual_list takes at most 10000 items,
// which a group of a few thousand changed lines passes when each line is one.
// shortcut: a group past about 5000 hunks still passes it; fold its files there if one ever does.
export const RUN = 32;

/** Where code starts in a row, past the line numbers and sign: notes and placeholders line up with it. */
export const codeInset = (split) => split ? 52 : 92;

const columns = (row) => Math.min(MAX_COLUMNS, row ? row.tokens.reduce((n, [text]) => n + [...text.replaceAll("\t", "    ")].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e7f ? 2 : 1), 0), 0) : 0);

/**
 * How wide the code must be to show its longest line, gutters included: unified rows, one `side` ("left", "right")
 * of split pairs, or the "solo" rows a split view gives an added or removed file, which take the whole width.
 */
export function contentWidth(items, side) {
  let most = 0;
  for (const item of items) {
    if (item.kind !== (!side ? "row" : side === "solo" ? "solo" : "pair")) continue;
    for (const line of item.lines) { const row = side && side !== "solo" ? line[side] : line; if (row) most = Math.max(most, columns(row)); }
  }
  return Math.ceil(codeInset(Boolean(side)) + most * CHAR + 16);
}

/** A page in words, for the pane's header. */
export function pageLabel(page, review) {
  const [, kind, ...rest] = page.split("/"), value = decodeURIComponent(rest.join("/"));
  if (kind === "worktree") return "Uncommitted changes";
  if (kind === "branch") return `${value} vs ${review?.base?.ref ?? "base"}`;
  if (kind === "commit") return review?.title || value.slice(0, 7);
  // A range as the Review bar names it: a branch against its upstream is what there is to push or pull.
  const [from, to] = value.split("...");
  if (kind === "compare" && to) return to.endsWith(`/${from}`) ? `To pull: ${from}` : from.endsWith(`/${to}`) ? `To push: ${to}` : `${to} vs ${from}`;
  return value;
}

/** Context lines on both sides; a run of deletions faces the additions that follow it. */
export function pairRows(rows) {
  const pairs = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind === " ") { pairs.push({ left: rows[i], right: rows[i] }); i++; continue; }
    const dels = [], adds = [];
    while (i < rows.length && rows[i].kind === "-") dels.push(rows[i++]);
    while (i < rows.length && rows[i].kind === "+") adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) pairs.push({ left: dels[k], right: adds[k] });
  }
  return pairs;
}

/** The width a note's text wraps at, past the row's or card's padding and border and the mark before it. */
// shortcut: Herdr's Markdown wraps without its inline code chips' padding, so a line of them runs past the width;
// 32px of slack covers a few chips a line. A wrap that counted the chips would drop it.
export const noteWidth = (width, anchored) => (anchored ? Math.min(width - 16, 800) - 22 : width - 24) - 20 - 32;

/**
 * Rough height of a note, as the app's AnalysisNoteCard lays it out: a file's own note is a row across the file
 * (12px in, 6px padding), a line's is a card under the line (8px in, at most 800 wide, 1px border, 4px padding,
 * 3px apart). Either has a 12px mark and an 8px gap before its text. CJK characters take two columns.
 */
export function noteHeight(text, width, anchored) {
  const columns = Math.max(20, Math.floor(noteWidth(width, anchored) / 7));
  const lines = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil([...line].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e7f ? 2 : 1), 0) / columns)), 0);
  return lines * NOTE_LINE + (anchored ? 16 : 12);
}

/**
 * A group's files as sidebar rows, ported from the app's `fileRows` (components/diff/file-rows.ts):
 * "list" is one row per path; "tree" nests them under folders, a chain of single-child folders
 * as one row (`packages/cli/src`), in the order the diffs show. Missing paths trail, as there.
 */
export function fileRows(paths, missing, layout) {
  const leaves = [...paths.map(path => ({ path, missing: false })), ...missing.map(path => ({ path, missing: true }))];
  if (layout === "list") return leaves.map(({ path, missing }) => ({ key: `${missing ? "missing" : "file"}:${path}`, depth: 0, type: missing ? "missing" : "file", name: path, path }));
  const root = { name: "", children: new Map() };
  for (const { path, missing } of leaves) {
    const segments = path.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      if (!node.children.has(segment)) node.children.set(segment, { name: segment, children: new Map() });
      node = node.children.get(segment);
    }
    node.children.set(`\0file:${path}`, { name: segments.at(-1), children: new Map(), path, missing });
  }
  const collect = (node) => [...node.children.values()].flatMap(child => child.path ? (child.missing ? [] : [child.path]) : collect(child));
  const rows = [];
  const walk = (node, depth, prefix) => {
    for (const [key, child] of node.children) {
      if (child.path) { rows.push({ key: `${child.missing ? "missing" : "file"}:${child.path}`, depth, type: child.missing ? "missing" : "file", name: child.name, path: child.path }); continue; }
      let name = child.name, tail = child, at = `${prefix}${key}/`;
      while (tail.children.size === 1) {
        const [onlyKey, only] = [...tail.children.entries()][0];
        if (only.path) break;
        name += `/${only.name}`; tail = only; at += `${onlyKey}/`;
      }
      rows.push({ key: `folder:${at}`, depth, type: "folder", name, paths: collect(tail) });
      walk(tail, depth + 1, at);
    }
  };
  walk(root, 0, "");
  return rows;
}

/** Every file a group shows: its own, then its children's. */
export const groupFiles = (group) => [...group.files, ...group.children.flatMap(child => child.files)];

/**
 * The list for one group: a header per child group, a header per file, and, unless the file
 * is collapsed, its notes and rows, in runs of up to RUN broken by a line's note. `full` holds a file's whole-file rows once loaded.
 * Returns the items with their heights, as `v_virtual_list` takes them.
 */
export function buildItems(review, group, { collapsed, full, split, width }) {
  const items = [], byPath = new Map(review.files.map(file => [file.path, file]));
  const push = (item, size) => { items.push({ ...item, size }); };
  const notesOf = (g, path) => [g, ...g.children].flatMap(x => x.notes[path] ?? []);
  const fileItems = (g, path) => {
    const file = byPath.get(path);
    if (!file) return;
    push({ key: `f:${path}`, kind: "file", file }, FILE);
    if (collapsed.has(path)) return;
    const notes = notesOf(group, path);
    // The file's own notes, and notes on lines no hunk shows, sit under its header as the app shows them; a rule ends them.
    const own = notes.filter(note => !note.anchor);
    for (const [i, note] of own.entries()) push({ key: `n:${path}:f${i}`, kind: "note", note, last: i === own.length - 1 }, noteHeight(note.text, width, false));
    const hunks = full.get(path) ? [{ header: null, rows: full.get(path) }] : file.hunks;
    if (!hunks) {
      push({ key: `e:${path}`, kind: "empty", text: "Loading…", loading: true }, ROW);
      return;
    }
    if (!hunks.length) {
      push({ key: `e:${path}`, kind: "empty", text: file.isBinary ? "Binary file" : file.truncated ? "Too large to show" : "No text changes" }, ROW);
      return;
    }
    // Split, an added or removed file has one side only: it takes the whole width rather than half.
    const solo = split && (file.status === "added" || file.status === "removed");
    const kind = !split ? "row" : solo ? "solo" : "pair";
    for (const [h, hunk] of hunks.entries()) {
      if (hunk.header) push({ key: `h:${path}:${h}`, kind: "hunk", text: hunk.header }, HUNK);
      const lines = split && !solo ? pairRows(hunk.rows) : hunk.rows;
      let run = null;
      for (const [r, line] of lines.entries()) {
        if (!run || run.lines.length === RUN) { run = { key: `r:${path}:${h}:${r}`, kind, lines: [] }; items.push(run); }
        run.lines.push(line); run.size = run.lines.length * ROW;
        const rows = kind === "pair" ? [line.left, line.right].filter(Boolean) : [line];
        for (const [i, note] of notes.entries()) {
          const at = note.anchor;
          if (at && rows.some(row => at.side === "additions" ? row.kind !== "-" && row.new === at.line : row.kind === "-" && row.old === at.line)) {
            push({ key: `n:${path}:${i}`, kind: "note", note, anchored: true }, noteHeight(note.text, width, true));
            run = null;
          }
        }
      }
    }
  };
  for (const path of group.files) fileItems(group, path);
  for (const child of group.children) {
    push({ key: `g:${child.key}`, kind: "group", group: child }, GROUP);
    for (const path of child.files) fileItems(child, path);
  }
  return items;
}
