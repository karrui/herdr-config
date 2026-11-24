import { openInViewer } from "./open.js";

// Cmd-click on a file path in a terminal: the file in the tab's viewer. What it doesn't show
// (a folder, a picture) passes on to Herdr's usual opener.
export async function handleLink({ link, source }) {
  if (link.kind !== "file" || !source.pane) return "pass";
  const line = Number(link.raw.match(/:(\d+)(?::\d+)?$/)?.[1]) || null;
  // A remote terminal's path comes unresolved: its folder there completes a relative one.
  let path = link.path;
  if (!path && source.machine) {
    const raw = link.raw.replace(/^file:\/\/[^/]*/, "").replace(/:\d+(?::\d+)?$/, "");
    path = raw.startsWith("/") ? raw : source.cwd && !raw.startsWith("~") ? `${source.cwd}/${raw}` : null;
  }
  return (await openInViewer({ path, line, on: source.machine, pane: source.pane })) ? "handled" : "pass";
}
