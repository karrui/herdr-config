// The artifact viewer (the person's decision): a chat card opens an artifact here; the
// Artifacts sidebar shows one in place instead (mods/artifacts). The image viewer's shell:
// mods/chat-image's toolbar (props.artifact, its artifact-bar.js) over the artifact's own mod,
// on a backdrop in the theme's colors. From a chat it covers that chat pane only, exactly like
// an opened image; with no pane to cover, the whole window.
// Shared: the same file in mods chat, chat-image and artifacts; change every copy alike.

import { exec, appHome, openOverlay, theme } from "herdr";
import { toast, plainError } from "./ui.js";

const CLI = () => `${appHome()}/mods/artifacts/bin/herdr-artifact`;

// The artifact helper (herdr-artifact, --json); a failure throws its own words.
export async function artifactCli(machine, args) {
  const r = await exec(CLI(), [...(machine ? ["--on", machine] : []), ...args, "--json"]);
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split("\n").pop() || "null"); } catch {}
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error || r.stderr?.trim() || "");
  return out;
}

// The latest version's mod name, from any version's (art-<id>--v<n>).
export const baseMod = (mod) => String(mod).replace(/--v\d+$/, "");

// The viewer's layout: the toolbar over the artifact's own mod, on the backdrop.
export function viewerLayout(artifact) {
  return {
    type: "column", background: `${theme().background}f2`, children: [
      { type: "block", size: { px: 48 }, content: { mod: "chat-image", props: { artifact } } },
      { type: "column", padding: [8, 24], children: [
        { type: "block", radius: 8, background: "background", border: { width: 1, color: "border" }, content: { mod: artifact.mod } }] }],
  };
}

// Shows an artifact whose mod is already in this app: over artifact.area ({ x, y, width, height }
// in the window: a chat pane, as the image viewer opens) when it has one, else the whole window.
// The area stays in the toolbar's props, so stepping versions reopens it in the same place.
export function showViewer(artifact) {
  const a = artifact.area;
  const at = a ? { x: Math.round(a.x), y: Math.round(a.y) } : { x: 0, y: 0 };
  const size = a ? { width: Math.round(a.width), height: Math.round(a.height) } : { width: 1, height: 1 };
  openOverlay({ kind: "popup", frame: "none", ...size, at, layout: viewerLayout(artifact) });
}

// Opens a: { id, title, version, latest?, machine }: its mod made in this app first (pulled from
// its machine), that version when it's older than the latest. area: the chat pane to cover
// (null: the whole window); show: what shows it once pulled (default the viewer).
export function openViewer(a, area = null, show = showViewer) {
  const machine = a.machine ?? null;
  const older = a.latest && a.version && a.version < a.latest;
  return artifactCli(null, ["pull", a.id, ...(machine ? ["--from", machine] : []), ...(older ? ["--version", String(a.version)] : [])])
    .then((out) => show({ mod: out.mod, base: baseMod(out.mod), id: a.id, title: a.title, version: a.version, latest: a.latest ?? a.version, machine, ...(area ? { area } : {}) }))
    .catch((e) => (needsApproval(e) ? openReview(a, area) : toast({ title: "Artifact didn't open", body: plainError(e), level: "error" })));
}

// An artifact whose code isn't approved yet (herdr-artifact installs only approved code, as Herdr
// runs it outside the sandbox): the review dialog (mods/artifacts review.js) shows its files,
// and Approve and open opens it.
export const needsApproval = (e) => /^needs approval/.test(String(e?.message ?? e));
export function openReview(art, area = null) {
  openOverlay({ mod: "artifacts", kind: "dialog", modal: true, width: 760, height: 620, props: { review: { art, area } } });
}
