// A clip from the chat (a show-your-work recording: mods/chat openVideo()), played as frames,
// since the app draws pictures, not video. props { video: { title, sides: [{ path, name, dur,
// w, h }], changes: [{ title, at }] }, width, height }; two sides play side by side on one
// clock (the card's Compare). Each clip is cut once by video.jxa (the system's AVFoundation) into
// data/chat-attach/frames/<key>/ (key: its path, size and time, the rate and width), and plays
// while it is still being cut. Play / pause: the button, space, a click on the picture. The scrub
// bar: pressed or dragged, left / right a second. The changes' moments are marked on the bar and
// listed under it (a click goes there and pauses).

import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, exec, appHome, closeOverlay } from "herdr";
import { TEXT, RADIUS } from "./ui.js";

const FPS = 12, WIDTH = 960;
// ponytail: every frame drawn stays in the app's image cache (image() keeps what it loaded), so a
// clip costs about frames x width x height x 4 bytes once a session; MOST frames caps that (about
// 600 MB at 960 x 540; a longer clip gets fewer a second). Drawing frames into one image would
// lift the cap, if the app ever offers that.
const MOST = 300;
const BAR = 48, CONTROLS = 48, PAD = 16, PLAY = 32, TIME_W = 96, GAP = 12;
// Where the scrub bar starts in the viewer: the controls' padding, Play and the time before it.
const SCRUB_X = PAD + PLAY + GAP + TIME_W + GAP;
const DIR = "data/chat-attach/frames";
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// A clip's folder: its key, from its path, size and time and how it's cut.
const KEY = `src="$1"; [ -f "$src" ] || exit 3
{ stat -f '%z %m' "$src" 2>/dev/null || stat -c '%s %Y' "$src"; printf '%s %s %s' "$src" "$2" "$3"; } | cksum | cut -d' ' -f1`;
// Cuts it once: a cut already running (from a viewer opened before) is left to finish. The
// newest 10 clips' frames are kept.
const CUT = `j="$1"; src="$2"; d="$3"; fps="$4"; w="$5"
mkdir -p "$d" || exit 1
[ -f "$d/done" ] && exit 0
if [ -f "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then exit 0; fi
echo $$ > "$d/pid"
( cd "\${d%/*}" && ls -t | grep -E '^[0-9]+$' | tail -n +11 | while IFS= read -r x; do rm -rf "./$x"; done )
osascript -l JavaScript "$j" "$src" "$d" "$fps" "$w" >/dev/null && touch "$d/done"`;
// How many frames are cut, and "done" once all are.
const COUNT = `n=$(ls "$1" 2>/dev/null | grep -c '[.]jpg$'); [ -f "$1/done" ] && echo "$n done" || echo "$n"`;

// init's cx outlives the call (an AsyncContext): the cut and the clock run on it, and stop
// once the viewer is closed (it throws then).
export function initVideo(v, cx) {
  const clip = props().video;
  const sides = (clip.sides ?? []).map((s) => ({ ...s, count: 0, done: false, failed: false, key: null }));
  const dur = Math.max(0, ...sides.map((s) => s.dur ?? 0));
  // One rate for both sides, so one clock shows the same moment in each.
  const fps = Math.max(1, Math.min(FPS, dur > 0 ? Math.floor(MOST / dur) : FPS));
  v.vid = { sides, dur, fps, t: 0, playing: true, last: Date.now(), scrubbing: false };
  for (const s of sides) cut(v, s, cx).catch(() => {});
  cx.timer.every(Math.round(1000 / fps), (cx) => tick(v, cx));
}

async function cut(v, s, cx) {
  const fps = v.vid.fps, w = Math.min(WIDTH, s.w || WIDTH);
  const k = await exec("sh", ["-c", KEY, "key", s.path, String(fps), String(w)]).catch(() => null);
  s.key = k?.code === 0 ? k.stdout.trim() : null;
  if (!s.key) { s.failed = true; cx.notify(); return; }
  const dir = `${appHome()}/${DIR}/${s.key}`;
  const poll = async () => {
    const r = await exec("sh", ["-c", COUNT, "count", dir]).catch(() => null);
    const [n, done] = (r?.stdout ?? "").trim().split(" ");
    s.count = Number(n) || 0;
    s.done = done === "done";
  };
  await poll();
  if (s.done) { cx.notify(); return; }
  let ended = false;
  exec("sh", ["-c", CUT, "cut", `${appHome()}/mods/chat-image/video.jxa`, s.path, dir, String(fps), String(w)])
    .then((r) => r.code === 0).catch(() => false)
    .then(async (ok) => { ended = true; await poll(); if (!ok && !s.count) s.failed = true; cx.notify(); });
  // Frames show as they come (and a cut another viewer started is waited on the same way).
  while (!ended && !s.done) {
    await new Promise((go) => cx.timer.after(400, go));
    await poll();
    cx.notify();
  }
}

// The clock: real time while playing, held at the last frame cut while the cut is behind.
function tick(v, cx) {
  const vid = v.vid;
  if (!vid.playing || vid.scrubbing) return;
  const now = Date.now();
  const cutTo = Math.min(...vid.sides.map((s) => (s.done || s.failed ? Infinity : Math.max(0, s.count - 1) / vid.fps)));
  vid.t = Math.max(0, Math.min(vid.t + (now - vid.last) / 1000, cutTo, vid.dur));
  vid.last = now;
  if (vid.t >= vid.dur) vid.playing = false;
  cx.notify();
}

function toggle(v) {
  const vid = v.vid;
  if (!vid.playing && vid.t >= vid.dur) vid.t = 0;
  vid.playing = !vid.playing;
  vid.last = Date.now();
}

function seek(v, t, pause = false) {
  const vid = v.vid;
  vid.t = Math.max(0, Math.min(vid.dur, t));
  vid.last = Date.now();
  if (pause) vid.playing = false;
}

function key(v, e, cx) {
  const k = e.key;
  if (k === "space") toggle(v);
  else if (k === "left") seek(v, v.vid.t - 1);
  else if (k === "right") seek(v, v.vid.t + 1);
  else return;
  cx.stop_propagation();
  cx.notify();
}

// The frames for a side at the clock: the one due on top, the one before under it (shown
// while the due one loads, so nothing flashes) and the next few under those, loading early.
function frames(v, s) {
  if (!s.key || !s.count) return [];
  const i = Math.min(s.count - 1, Math.floor(v.vid.t * v.vid.fps));
  const rel = (n) => `${DIR}/${s.key}/${String(n + 1).padStart(4, "0")}.jpg`;
  return [i + 3, i + 2, i + 1, i - 1, i].filter((n) => n >= 0 && n < s.count).map(rel);
}

// The player: toolbar (btn, rule: the viewer's own), the clip (or both), the controls, the
// changes' list.
export function videoView(v, t, btn, rule) {
  const vid = v.vid, clip = props().video;
  const W = props()?.width ?? 800, H = props()?.height ?? 600;
  const many = vid.sides.length > 1;
  const failed = vid.sides.every((s) => s.failed);
  const waiting = !failed && vid.sides.some((s) => !s.failed && !s.count);
  const changes = (clip.changes ?? []).filter((c) => c.at != null && c.at <= vid.dur + 0.5);
  const now = changes.reduce((k, c, i) => (c.at <= vid.t + 0.05 ? i : k), -1);
  // The stage: what the toolbar, the controls and the changes' list leave.
  const listH = changes.length ? 40 : 0;
  const stageH = Math.max(80, H - BAR - CONTROLS - listH);
  const room = (W - 2 * PAD - (many ? GAP : 0)) / vid.sides.length, roomH = stageH - 2 * PAD - (many ? 22 : 0);
  const fit = (s) => { const k = Math.min(1, room / (s.w || 640), roomH / (s.h || 400)); return { w: Math.round((s.w || 640) * k), h: Math.round((s.h || 400) * k) }; };
  const side = (s, n) => {
    const f = fit(s);
    return v_flex().gap(6).items_center()
      .when(many, (el) => el.child(div().h(16).text_size(TEXT.label).text_color(t.muted).child(s.name)))
      .child(div().id(`clip-${n}`).relative().w(f.w).h(f.h).rounded(4).overflow_hidden().bg(t.raised).shadow_lg().cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); toggle(v); cx.notify(); })
        .children(frames(v, s).map((rel) => image(rel).absolute().inset_0().size_full())));
  };
  const scrubW = Math.max(40, W - SCRUB_X - PAD);
  const at = (sec) => (vid.dur > 0 ? (Math.max(0, Math.min(vid.dur, sec)) / vid.dur) * scrubW : 0);
  const cutTo = Math.min(...vid.sides.map((s) => (s.done || s.failed ? vid.dur : s.count / vid.fps)));
  const file = vid.sides[vid.sides.length - 1]?.path;
  return v_flex().id("viewer").w(W).h(H).bg(`${t.background}f2`)
    .track_focus(v.handle)
    .on_key_down((e, cx) => key(v, e, cx))
    // Dragging the playhead: the bar took the press, the move and release come here.
    .on_mouse_move((e, cx) => { if (!vid.scrubbing) return; seek(v, ((e.local_position.x - SCRUB_X) / scrubW) * vid.dur); cx.notify(); })
    .on_mouse_up("left", (_e, cx) => { if (!vid.scrubbing) return; vid.scrubbing = false; vid.last = Date.now(); cx.notify(); })
    // The toolbar: the title (and that frames are on their way); open it in its own app, show
    // it in its folder; close.
    .child(h_flex().id("bar").w_full().h(BAR).flex_none().pl(PAD).pr(8).gap(2).items_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().flex_1().min_w(0).gap(8).items_baseline().text_size(TEXT.body)
        .child(div().min_w(0).truncate().font_medium().text_color(t.foreground).child(clip.title ?? "Clip"))
        .when(waiting, (el) => el.child(div().flex_none().text_size(TEXT.label).text_color(t.muted).child("Preparing frames…"))))
      .child(btn("open", "external-link", "Open in its own app", () => exec("open", [file]).catch(() => {}), t))
      .child(btn("reveal", "folder-open", "Show in folder", () => exec("open", ["-R", file]).catch(() => {}), t))
      .child(rule(t))
      .child(btn("close", "x", "Close  Esc", () => closeOverlay(props()?.overlay), t)))
    // A click beside the clip closes, as beside a picture.
    .child(h_flex().id("stage").w_full().flex_1().min_h(0).gap(GAP).items_center().justify_center().overflow_hidden()
      .on_click(() => closeOverlay(props()?.overlay))
      .when(failed, (el) => el.child(v_flex().gap(4).items_center().text_size(TEXT.body).text_color(t.muted)
        .child(div().child("Can't play this clip here."))
        .child(div().text_size(TEXT.label).child("Open it in its own app from the bar above."))))
      .when(!failed, (el) => el.children(vid.sides.map(side))))
    // Play / pause, where it is, and the scrub bar: the part cut, the part played, the changes'
    // moments, the playhead.
    .child(h_flex().id("controls").w_full().h(CONTROLS).flex_none().px(PAD).gap(GAP).items_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().id("play").size(PLAY).flex_none().flex().items_center().justify_center().rounded(RADIUS.control).cursor_pointer()
        .text_color(t.foreground).hover((s) => s.bg(t.hover)).tooltip(vid.playing ? "Pause  Space" : "Play  Space")
        .on_click((_e, cx) => { cx.stop_propagation(); toggle(v); cx.notify(); })
        .child(svg(`mods/chat-image/${vid.playing ? "pause" : "play"}.svg`).size(14)))
      .child(div().w(TIME_W).flex_none().text_size(TEXT.label).text_color(t.muted).child(`${clock(vid.t)} / ${clock(vid.dur)}`))
      .child(div().id("scrub").relative().w(scrubW).h(24).flex_none().cursor_pointer()
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); vid.scrubbing = true; seek(v, (e.local_position.x / scrubW) * vid.dur); cx.notify(); })
        .child(div().absolute().left(0).w(scrubW).top(10).h(4).rounded(2).bg(t.border))
        .child(div().absolute().left(0).top(10).h(4).w(at(cutTo)).rounded(2).bg(t.foreground + "26"))
        .child(div().absolute().left(0).top(10).h(4).w(at(vid.t)).rounded(2).bg(t.accent))
        .children(changes.map((c) => div().absolute().left(at(c.at) - 1).top(6).w(2).h(12).rounded(1).bg(t.foreground).opacity(0.7)))
        .child(div().absolute().left(at(vid.t) - 6).top(6).size(12).rounded(6).bg(t.foreground))))
    // The changes, each at its moment: a click goes there and pauses; the one shown now is lit.
    .when(changes.length > 0, (el) => el.child(h_flex().id("changes").w_full().h(listH).flex_none().px(PAD).gap(6).items_start().overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(changes.map((c, i) => h_flex().id(`change-${i}`).h(26).flex_none().px(8).gap(6).items_center().rounded(RADIUS.control).cursor_pointer()
        .text_size(TEXT.label).border_1().border_color(i === now ? t.accent : t.border).bg(i === now ? t.accent + "1f" : t.background)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); seek(v, c.at, true); cx.notify(); })
        .child(div().flex_none().text_color(t.muted).child(clock(c.at)))
        .child(div().text_color(t.foreground).child(c.title))))));
}
