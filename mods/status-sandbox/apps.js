import { exec, window } from "herdr";
import { loginExec } from "./shell.js";

const inside = (path, root) => path === root || path?.startsWith(`${root.replace(/\/$/, "")}/`);

// lsof's field output keeps spaces in process names and folders intact.
export function listeners(text) {
  const rows = [];
  let process;
  for (const line of text.split("\n")) {
    if (line[0] === "p") process = { pid: line.slice(1), name: "App" };
    if (line[0] === "c" && process) process.name = line.slice(1);
    if (line[0] !== "n" || !process) continue;
    const match = /^n(.+):(\d+)$/.exec(line);
    if (!match) continue;
    let host = match[1];
    if (host === "*" || host === "0.0.0.0") host = "127.0.0.1";
    if (host === "[::]" || host === "::") host = "[::1]";
    rows.push({ ...process, host, port: Number(match[2]) });
  }
  return rows;
}

export function workspaceListeners(rows, text, root) {
  const folders = {};
  let pid;
  for (const line of text.split("\n")) {
    if (line[0] === "p") pid = line.slice(1);
    if (line[0] === "n" && pid) folders[pid] = line.slice(1);
  }
  return rows.filter(row => inside(folders[row.pid], root));
}

// Serve's Web keys contain the public host and port; Proxy contains the backend.
export function serveLinks(config) {
  const links = [];
  for (const [host, web] of Object.entries(config.Web ?? {})) {
    const port = host.split(":").pop(), scheme = config.TCP?.[port]?.HTTP ? "http" : "https";
    for (const [path, handler] of Object.entries(web.Handlers ?? {})) {
      const proxy = /^(?:(https?(?:\+insecure)?):\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)(?:\/.*)?$/.exec(handler.Proxy ?? "");
      if (!proxy) continue;
      links.push({ port: Number(proxy[2]), url: `${scheme}://${host}${path.startsWith("/") ? path : `/${path}`}` });
    }
  }
  for (const child of [...Object.values(config.Foreground ?? {}), ...Object.values(config.Services ?? {})]) links.push(...serveLinks(child));
  return links;
}

export async function appURLs(apps, machine) {
  if (!machine) return apps.map(app => ({ ...app, browserUrl: app.url }));
  const [status, node] = await Promise.all([
    loginExec("tailscale", ["serve", "status", "--json"], { on: machine }),
    loginExec("tailscale", ["status", "--json"], { on: machine }),
  ]);
  for (const result of [status, node]) {
    if (result.code !== 0) throw new Error(result.stderr || "Couldn't read Tailscale URLs.");
  }
  const links = serveLinks(JSON.parse(status.stdout));
  const host = JSON.parse(node.stdout).Self?.DNSName?.replace(/\.$/, "");
  if (!host) throw new Error("This machine has no Tailscale hostname.");
  return apps.map(app => ({ ...app, browserUrl: links.find(link => link.port === app.port)?.url ?? `https://${host}:${app.port}/` }));
}

export async function scanApps({ cwd, machine }, previous = []) {
  const results = await Promise.all([
    exec("sh", ["-c", "git rev-parse --show-toplevel 2>/dev/null || pwd -P"], { cwd, on: machine }),
    exec("lsof", ["-w", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { on: machine }),
  ]);
  const [git, sockets] = results;
  if (sockets.code !== 0 && sockets.stderr?.trim()) throw new Error(sockets.stderr.trim());
  const rows = listeners(sockets.stdout), root = git.code === 0 ? git.stdout.trim() : cwd.replace(/\/$/, "");
  if (!rows.length) return [];
  const folders = await exec("lsof", ["-w", "-a", "-p", [...new Set(rows.map(row => row.pid))].join(","), "-d", "cwd", "-Fn"], { on: machine });
  const candidates = workspaceListeners(rows, folders.stdout, root);
  const apps = new Map();
  // A HEAD request confirms HTTP without following redirects or fetching page bodies.
  for (let i = 0; i < candidates.length; i += 8) {
    await Promise.all(candidates.slice(i, i + 8).map(async row => {
      if (apps.has(row.port)) return;
      // A still-listening socket needs no repeat HTTP request (or repeat dev-server logs).
      const known = previous.find(app => app.pid === row.pid && app.port === row.port && app.host === row.host);
      if (known) { apps.set(row.port, known); return; }
      for (const scheme of ["http", "https"]) {
        const url = `${scheme}://${row.host}:${row.port}`;
        const result = await exec("curl", ["--noproxy", "*", "-k", "-s", "-I", "--max-time", "1", "-o", "/dev/null", "-w", "%{http_code}", url], { on: machine });
        if (/^[1-5]\d\d$/.test(result.stdout.trim())) { apps.set(row.port, { ...row, url }); break; }
      }
    }));
  }
  return [...apps.values()].sort((a, b) => a.port - b.port);
}

export async function serveApp(app, machine) {
  const status = await loginExec("tailscale", ["serve", "status", "--json"], { on: machine });
  if (status.code !== 0) throw new Error(status.stderr || "Couldn't read Tailscale Serve.");
  const config = JSON.parse(status.stdout), existing = serveLinks(config).find(link => link.port === app.port);
  if (existing) return existing.url;
  const node = await loginExec("tailscale", ["status", "--json"], { on: machine });
  if (node.code !== 0) throw new Error(node.stderr || "Couldn't read this machine's Tailscale hostname.");
  const host = JSON.parse(node.stdout).Self?.DNSName?.replace(/\.$/, "");
  if (!host) throw new Error("This machine has no Tailscale hostname.");
  const occupied = cfg => Boolean(cfg.TCP?.[app.port]) || Object.values(cfg.Foreground ?? {}).some(occupied);
  if (occupied(config)) throw new Error(`Tailscale Serve port ${app.port} already belongs to another service.`);
  const port = app.port;
  const target = app.url.replace(/^https:/, "https+insecure:");
  const args = ["serve", "--bg", `--https=${port}`, target];
  let result = await loginExec("tailscale", args, { on: machine });
  if (result.code !== 0) result = await loginExec("sudo", ["-n", "tailscale", ...args], { on: machine });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "This machine hasn't allowed Tailscale Serve.");
  return `https://${host}:${port}/`;
}

export async function openApp(app, machine) {
  const url = machine ? await serveApp(app, machine) : app.url;
  const platform = window()?.platform;
  const [command, args] = platform === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : platform === "linux" ? ["xdg-open", [url]] : ["open", [url]];
  const result = await exec(command, args);
  if (result.code !== 0) throw new Error(result.stderr || "Couldn't open the browser.");
}
