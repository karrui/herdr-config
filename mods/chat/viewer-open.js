import { exec as execFile, panes, run, setShared, window } from "herdr";

// What the viewer won't show as text: pictures, archives, media, office files. The system app
// opens those.
const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|icns|heic|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|dmg|pkg|exe|dll|so|dylib|a|o|class|wasm|mp[34]|mov|m4a|wav|ogg|flac|webm|avi|mkv|woff2?|ttf|otf|eot|sqlite3?|db|xlsx?|docx?|pptx?|key|numbers|pages)$/i;

// A file (`path` on machine `on`) in the viewer of `pane`'s tab, scrolled to `line`: the
// tab's viewer gets it as a tab of its own (main.js render()), or a viewer splits off right
// of `pane` with it. False for what the viewer doesn't show: a folder, a missing file, a
// picture; the caller opens that the way it did before.
export async function openInViewer({ path, line = null, on = null, pane }) {
  const tab = panes().find((p) => p.pane === pane)?.tab;
  if (!tab || !path || BINARY.test(path)) return false;
  const r = await execFile("test", ["-f", path], { on }).catch(() => null);
  if (r?.code !== 0) return false;
  const file = { path, line, on };
  if (panes().some((p) => p.mod === "viewer" && p.tab === tab)) setShared("viewer.open", { tab, file, n: Date.now() });
  else run("pane.split", { direction: "right", pane, mod: "viewer", props: { tab, file } });
  return true;
}

// A web link, or a file on this computer, in the system's app for it.
export async function openExternal(target) {
  if (/^(javascript|data|vbscript):/i.test(target)) throw new Error("This link type cannot be opened.");
  const platform = window()?.platform;
  const [cmd, args] = platform === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", target]] : platform === "linux" ? ["xdg-open", [target]] : ["open", [target]];
  const r = await execFile(cmd, args);
  if (r.code !== 0) throw new Error(r.stderr || "The system could not open this link.");
  return r;
}
