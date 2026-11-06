import { exec, home, window } from "herdr";

export function codeTarget(link, cwd) {
  let value = String(link);
  if (/^file:/i.test(value)) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== "localhost") return null; value = url.pathname + url.hash; } catch { return null; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/:\s]+\.[^/:\s]+:\d+(?::\d+)?$/.test(value)) return null;
  try { value = decodeURIComponent(value); } catch { return null; }
  const anchor = /#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/.exec(value), suffix = !anchor && /:(\d+)(?::\d+)?$/.exec(value);
  const line = Number((anchor || suffix)?.[1]) || null;
  value = value.slice(0, (anchor || suffix)?.index ?? value.length);
  if (!value || value.includes("\0") || value.startsWith("#")) return null;
  if (value.startsWith("~/")) value = home() + value.slice(1);
  if (!value.startsWith("/")) {
    if (!cwd || (!value.includes("/") && !value.includes("."))) return null;
    value = `${cwd}/${value}`;
  }
  const parts = [];
  for (const part of value.split("/")) { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); }
  return { path: "/" + parts.join("/"), line };
}

async function external(url) {
  if (/^(javascript|data|vbscript):/i.test(url)) throw new Error("This link type cannot be opened.");
  const platform = window()?.platform;
  const [cmd, args] = platform === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : platform === "linux" ? ["xdg-open", [url]] : ["open", [url]];
  const result = await exec(cmd, args);
  if (result.code !== 0) throw new Error(result.stderr || "The system could not open this link.");
  return result;
}

export async function openCodeLink(link, { cwd, machine }) {
  const target = codeTarget(link, cwd);
  if (!target) return external(link);
  if (machine) throw new Error("Remote files must be opened on their own machine.");
  return external(target.path);
}
