// Files for the message box: pasted (a clipboard image, or copied files) or dropped. They go
// to the agent the way its CLI reads them: as file paths in the message (Claude Code turns an
// image path into an image). An agent on another machine gets a copy there first (`hc put`).
// Pasted images and texts are kept in DIR until the person sends or removes them. DIR is outside
// data/ (which holds keys), so a sandboxed agent can read it (sandbox/agent-sandbox).

import { exec, hc, appHome } from "herdr";
import * as fs from "fs/promises";

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const base = (p) => String(p).split("/").filter(Boolean).pop() ?? p;
export const isImage = (p) => IMAGE.test(p);
const DIR = `${appHome()}/attach`;

// The clipboard's copied files, else its image saved as a PNG (clipboard.jxa, macOS).
// [{ path, name, image, temp }] or [].
export async function fromClipboard() {
  const stem = `pasted-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`;
  const r = await exec("osascript", ["-l", "JavaScript", `${appHome()}/mods/chat/clipboard.jxa`, DIR, stem]);
  const lines = r.stdout.split("\n").map((l) => l.split("\t")).filter(([k, p]) => p && (k === "F" || k === "I"));
  const image = lines.find(([k]) => k === "I");
  if (image) return [{ path: image[1], name: base(image[1]), image: true, temp: true }];
  return paths(lines.map(([, p]) => p));
}

// Dropped or pasted file paths as attachments.
export const paths = (list) => list.filter(Boolean).map((p) => ({ path: p, name: base(p), image: isImage(p), temp: false }));

// The message's file lines: each file's path where the agent is. For another machine, a copy
// lands beside the agent's terminal. A sandboxed agent can't read most of home (Desktop,
// Downloads): a file from outside its folder goes as a copy in DIR (a clone, so no extra space).
// Folders, and files in its folder, go by their own path.
export async function deliver(files, addr, machine, { sandbox = false, folder = null } = {}) {
  const out = [];
  for (const f of files) {
    if (!machine && sandbox && !f.path.startsWith(`${DIR}/`) && !(folder && f.path.startsWith(`${folder}/`))) {
      const r = await exec("sh", ["-c", '[ -f "$2" ] || exit 3; d="$1/sent-$(date +%s)-$$"; mkdir -p "$d" && cp -c "$2" "$d/" 2>/dev/null || cp "$2" "$d/" && printf %s "$d/${2##*/}"', "x", DIR, f.path]);
      out.push(r.code === 0 && r.stdout ? r.stdout : f.path);
      continue;
    }
    if (!machine) { out.push(f.path); continue; }
    const r = await hc(["put", addr, f.path, "--json"]);
    let landed = null;
    try { landed = JSON.parse(r.stdout || "{}").path ?? null; } catch { landed = r.stdout.trim() || null; }
    if (r.code !== 0 || !landed) throw new Error(`${f.name} didn't reach ${machine}: ${(r.stderr || r.stdout).trim()}`);
    out.push(landed);
  }
  return out;
}

// A pasted image removed before sending goes. Sent ones stay a day (the agent may read them
// later), then go.
export function drop(f) {
  if (f.temp && f.path.startsWith(`${DIR}/`)) exec("rm", ["-f", f.path]);
}
export function prune() {
  exec("sh", ["-c", 'find "$1" -mindepth 1 -maxdepth 1 \\( -name "pasted-*" -o -name "sent-*" \\) -mmin +1440 -exec rm -rf {} + 2>/dev/null; true', "x", DIR]);
}

// Images shown in the chat (thumbnails, the viewer): `image()` loads from the app's folder, so
// each one is linked (or copied) into data/chat-attach/view, with its pixel size for fitting.
// Resolves { <path>: { rel, w, h, video, dur } } for the ones that exist here and are images
// (or clips: their first frame, and dur their length in seconds when the system can tell).
const VIEW = `
j="$1"; d="$2"; shift 2; mkdir -p "$d"
for p in "$@"; do
  [ -f "$p" ] || continue
  n=$(printf '%s' "$p" | cksum | cut -d' ' -f1)-$(printf '%s' "\${p##*/}" | tr -c 'A-Za-z0-9._-' '_')
  src="$p" v=""
  case "$p" in
    # A video shows its first frame (Quick Look's thumbnail), marked to play, with its length
    # (chat-image's video.jxa).
    *.mp4|*.MP4|*.mov|*.MOV|*.m4v|*.webm)
      n="$n.png" v="v:$(osascript -l JavaScript "$j" "$p" 2>/dev/null | cut -d' ' -f1)"
      [ -f "$d/$n" ] || { qlmanage -t -s 960 -o "$d" "$p" >/dev/null 2>&1 && mv -f "$d/\${p##*/}.png" "$d/$n" 2>/dev/null; } || continue
      src="$d/$n" ;;
  esac
  s=$(magick identify -format '%w %h' "$src[0]" 2>/dev/null) || s=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=' ' "$src" 2>/dev/null) ||
    s=$(sips -g pixelWidth -g pixelHeight "$src" 2>/dev/null | awk '/pixelWidth/ {w=$2} /pixelHeight/ {h=$2} END {if (w && h) print w " " h}')
  [ -n "$s" ] || continue
  [ -f "$d/$n" ] || ln -f "$p" "$d/$n" 2>/dev/null || cp "$p" "$d/$n" 2>/dev/null || continue
  printf '%s\\t%s\\t%s\\t%s\\n' "$p" "$n" "$s" "$v"
done
true`;
export async function viewable(list) {
  const dir = `${appHome()}/data/chat-attach/view`;
  const r = await exec("sh", ["-c", VIEW, "view", `${appHome()}/mods/chat-image/video.jxa`, dir, ...list]).catch(() => null);
  const out = {};
  for (const line of (r?.stdout ?? "").split("\n")) {
    const [p, n, size, v] = line.split("\t");
    const [w, h] = (size ?? "").split(" ").map(Number);
    if (p && n && w && h) out[p] = { rel: `data/chat-attach/view/${n}`, w, h, video: Boolean(v), dur: Number(String(v ?? "").slice(2)) || null };
  }
  return out;
}

// A w×h image covering a size×size square: its drawn size and offset (the middle shows).
export function cover(w, h, size) {
  const k = size / Math.min(w, h);
  const dw = Math.round(w * k), dh = Math.round(h * k);
  return { w: dw, h: dh, left: Math.round((size - dw) / 2), top: Math.round((size - dh) / 2) };
}

// A big paste kept as a text file (sent by path like other files): DIR, named after its
// first line.
export async function textFile(text) {
  const first = String(text).split("\n").find((l) => l.trim())?.trim() ?? "pasted text";
  const slug = first.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "pasted-text";
  const name = `pasted-${Date.now().toString(36)}-${slug}.txt`;
  const path = `${DIR}/${name}`;
  try {
    await exec("mkdir", ["-p", DIR]);
    await fs.writeFile(path, text);
  } catch { return null; }
  return { path, name: first.length > 40 ? first.slice(0, 39) + "…" : first, image: false, text: true, temp: true };
}

// LOG omits base64 from messages. Read those images once from their original byte offsets
// and cache them beside other attachments, so the existing thumbnail and viewer path works.
const LOG_IMAGES = String.raw`
import base64, hashlib, json, os, sys
file, dest, *offsets = sys.argv[1:]
out = {}
exts = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/tiff": "tiff"}
with open(file, "rb") as source:
    for offset in offsets:
        source.seek(int(offset))
        try:
            content = json.loads(source.readline()).get("payload", {}).get("content", [])
        except (ValueError, TypeError):
            continue
        for i, item in enumerate(content):
            if not isinstance(item, dict) or item.get("type") != "input_image":
                continue
            url = item.get("image_url", "")
            if not isinstance(url, str) or not url.startswith("data:image/") or "," not in url:
                continue
            head, encoded = url.split(",", 1)
            ext = exts.get(head[5:].split(";")[0])
            if not ext or not head.endswith(";base64"):
                continue
            try:
                data = base64.b64decode(encoded, validate=True)
            except ValueError:
                continue
            os.makedirs(dest, exist_ok=True)
            path = os.path.join(dest, hashlib.sha256(data).hexdigest() + "." + ext)
            if not os.path.exists(path):
                temp = path + "." + str(os.getpid()) + ".tmp"
                with open(temp, "wb") as target:
                    target.write(data)
                os.replace(temp, path)
            out.setdefault(offset, {})[str(i)] = path
print(json.dumps(out))
`;

export async function logImages(file, stdout) {
  const lines = stdout.split("\n"), entries = [];
  lines.forEach((line, index) => {
    const m = /^(\d+)\tJ\t(.*)$/.exec(line);
    if (!m || !m[2].includes('"type":"input_image"')) return;
    let record;
    try { record = JSON.parse(m[2]); } catch { return; }
    if (record.payload?.role === "user" && Array.isArray(record.payload.content)) entries.push({ index, off: m[1], record });
  });
  if (!entries.length) return stdout;
  try {
    const r = await exec("python3", ["-c", LOG_IMAGES, file, `${DIR}/log-images`, ...entries.map((e) => e.off)]);
    if (r.code !== 0) return stdout;
    const paths = JSON.parse(r.stdout);
    for (const { index, off, record } of entries) {
      for (const [i, path] of Object.entries(paths[off] ?? {})) record.payload.content[Number(i)].image_url = path;
      lines[index] = `${off}\tJ\t${JSON.stringify(record)}`;
    }
    return lines.join("\n");
  } catch { return stdout; }
}
