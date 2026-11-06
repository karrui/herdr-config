// A pane's header (Herdr's `pane` mod, cloned), plus Run: the commands Claude Code's
// latest reply asks you to run with `!` (`! gh auth login`, inline or in a code block).
// Run types `! <command>` into the agent, so it runs in its session and its output
// lands in the conversation; for a sandboxed agent, where the command would hit the
// sandbox too, it runs in a shell outside it, split below. Several are listed on hover.
// Claude Code and Codex panes also get Chat | Terminal (as Shepherdr's pane-chat has it): Chat
// puts the `chat` mod in the agent pane's spot and parks the agent's terminal behind it (it
// keeps running, labelled herdr.chat=<chat pane>); Terminal does the reverse. A chat pane's
// header shows its agent. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
// herdr's exec takes an argv list and never goes through a shell.
import { panes, terminals, props, run, theme, home, hc, appHome, readTextFile, settings, watchFolder, notify, nextCommand, setShared, exec as execFile } from "herdr";

const CHAT = "chat", LABEL = "herdr.chat";
// When a toggle last swapped a pane (every copy of this build shares it).
let lastSwap = 0;
// The chat reads Claude Code's and Codex's own session logs; other programs have no chat.
const chatty = (p) => Boolean(p?.terminal) && ["claude-code", "codex"].includes(p.app);
// The agent a chat pane shows, and the chat pane showing an agent.
const agentOf = (chat) => terminals().find((x) => x.labels?.[LABEL] === chat && x.state === "live") ?? null;
const chatOf = (terminal) => {
  const c = terminals().find((x) => x.address === terminal)?.labels?.[LABEL];
  return c && panes().some((p) => p.pane === c && p.mod === CHAT) ? c : null;
};

// One app command, waited for: a swap's steps go in order.
async function app(name, args) {
  const r = await execFile("herdr-app", ["do", name, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)])]);
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch {}
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${name} failed`);
  return out;
}

// Terminal → Chat: the chat splits beside the agent's pane, then the terminal is parked, so the
// chat takes its spot. The park removes the pane this header is on: it goes last.
export async function toChat(p) {
  const open = chatOf(p.terminal);
  if (open) return run("pane.focus", { pane: open });
  try {
    const out = await app("pane.split", { direction: "right", pane: p.pane, mod: CHAT, props: { terminal: p.terminal } });
    if (!out.pane) throw new Error("Herdr didn't open the chat.");
    await hc(["label", p.terminal, `${LABEL}=${out.pane}`]);
    run("pane.focus", { pane: out.pane });
    await app("terminal.park", { terminal: p.terminal });
  } catch (e) {
    notify({ title: "Chat didn't open", body: String(e?.message ?? e), level: "error" });
  }
}

// Chat → Terminal: the terminal gets a pane beside the chat again, then the chat closes.
async function toTerminal(chat) {
  const k = agentOf(chat);
  if (!k || panes().some((x) => x.terminal === k.address)) {
    run("pane.close", { pane: chat });
    if (k) hc(["label", k.address, `${LABEL}=`]);
    return;
  }
  try {
    await app("pane.focus", { pane: chat });
    const out = await app("terminal.keep", { terminal: k.address, place: "right" });
    await hc(["label", k.address, `${LABEL}=`]);
    if (out.pane) run("pane.focus", { pane: out.pane });
    await app("pane.close", { pane: chat });
  } catch (e) {
    notify({ title: "Terminal didn't come back", body: String(e?.message ?? e), level: "error" });
  }
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// The `! command`s in a reply: `! cmd` in backticks, and lines starting "! " in code
// blocks. Ones with a placeholder to fill in (`--input <that path>`) are left out.
export function bangs(text) {
  const found = [...text.matchAll(/`!\s*([^`\n]+)`/g)].map((m) => m[1]);
  for (const [, block] of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const [, cmd] of block.matchAll(/^\s*!\s*(\S.*)$/gm)) found.push(cmd);
  }
  return [...new Set(found.map((c) => c.trim()))].filter((c) => c && !/<[a-z][^>]*>/i.test(c));
}

// The agent's transcript, as the status line feed names it.
async function transcript(terminal) {
  const feed = await readTextFile(`${appHome()}/usage/claude/${terminal}.json`).catch(() => null);
  try { return JSON.parse(feed ?? "null")?.transcript ?? null; } catch { return null; }
}

// What Claude Code said since you last wrote to it: its transcript's assistant text after
// the last prompt (a tool's result is not one).
async function suggestions(file) {
  // ponytail: the last 300 entries; a reply longer than that loses its start.
  const r = await execFile("/usr/bin/tail", ["-n", "300", file]).catch(() => null);
  const texts = [];
  for (const line of (r?.stdout ?? "").split("\n").reverse()) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e.message?.content;
    if (e.type === "user" && !e.isMeta && (typeof content === "string" || content?.some?.((c) => c.type === "text"))) break;
    if (e.type === "assistant" && Array.isArray(content)) for (const c of content) if (c.type === "text") texts.unshift(c.text);
  }
  return bangs(texts.join("\n"));
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false; this.cmds = []; this.seen = null; this.watched = null; this.busy = false;
    // "pane-sandbox.toggle" (the chat's Open terminal, a key, `herdr-app do`): the focused pane
    // switches, as Shepherdr's pane-chat.toggle. Every copy hears it; the focused pane's acts. A
    // copy just started (the swap's new pane) may still be handed the toggle that made it, so
    // toggles go to copies at least 2 s old, one swap per 3 s. At most 5 s per wait, so a
    // reload's old build ends at its next cx use.
    this.born = Date.now();
    cx.spawn(async (cx) => {
      let cmd = null;
      for (;;) {
        cmd ??= nextCommand();
        const c = await Promise.race([cmd, cx.sleep(5000)]);
        if (c === undefined) continue;
        cmd = null;
        const p = this.me();
        if (c !== "toggle" || !p?.focused || Date.now() - this.born < 2000 || Date.now() - lastSwap < 3000) continue;
        lastSwap = Date.now();
        if (p.chat) this.swap(() => toTerminal(p.pane));
        else if (chatty(p)) this.swap(() => toChat(p));
      }
    });
  }

  // This pane; a chat pane as its agent (terminal, program, status, folder), with chat set.
  me() {
    const p = panes().find((p) => p.pane === props()?.pane);
    if (p?.mod !== CHAT) return p;
    const k = agentOf(p.pane);
    if (!k) return { ...p, chat: true };
    const status = ["working", "blocked", "done", "idle"].includes(k.status) ? k.status : null;
    // (A terminal's app is in its report, as parked.js reads it.)
    return { ...p, chat: true, terminal: k.address, program: k.program, app: k.report?.app ?? k.app, status, cwd: k.foreground?.cwd ?? k.cwd, title: k.title };
  }

  swap(fn) {
    if (this.busy) return;
    this.busy = true;
    fn().finally(() => { this.busy = false; });
  }

  // Chat | Terminal.
  switcher(t, p) {
    const seg = (id, label, on, action) => h_flex().id(id).h(18).px(8).items_center().rounded(4).text_size(11.5).font_medium()
      .when(on, (el) => el.bg(t.background).text_color(t.foreground).shadow_sm())
      .when(!on, (el) => el.text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); action(); }))
      .child(label);
    return h_flex().flex_none().p(2).gap(2).rounded(6).bg(t.raised)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(seg(`ph-chat-${p.pane}`, "Chat", Boolean(p.chat), () => this.swap(() => toChat(p))))
      .child(seg(`ph-term-${p.pane}`, "Terminal", !p.chat, () => this.swap(() => toTerminal(p.pane))));
  }

  // Looked at again when the agent's status changes: a reply ends, or you write.
  look(p, cx) {
    const key = `${p.terminal}|${p.app}|${p.status}`;
    if (key === this.seen) return;
    this.seen = key;
    if (p.app !== "claude-code" || !p.terminal) { this.cmds = []; return; }
    cx.spawn(async (cx) => {
      const file = await transcript(p.terminal);
      const cmds = file ? await suggestions(file) : [];
      if (this.seen !== key) return;
      this.cmds = cmds;
      if (file) this.watch(file, cx);
      cx.notify();
    });
  }

  // The status can turn before Claude Code has written the reply out, so its transcript
  // is read again whenever it changes while the agent isn't working.
  watch(file, cx) {
    if (this.watched === file) return;
    this.watched = file;
    const dir = file.slice(0, file.lastIndexOf("/")), name = file.slice(dir.length + 1);
    cx.spawn(async (cx) => {
      while (this.watched === file) {
        const changed = await watchFolder(dir).catch(() => null);
        if (!changed) return;
        if (this.watched === file && changed.some((f) => f.endsWith(name)) && this.me()?.status !== "working") { this.seen = null; cx.notify(); }
      }
    });
  }

  sandboxed(p) {
    return Boolean(terminals().find((x) => x.address === p.terminal)?.labels?.["herdr.sandbox"]);
  }

  runCmd(p, cmd) {
    this.cmds = this.cmds.filter((c) => c !== cmd);
    if (!this.sandboxed(p)) return hc(["send", p.terminal, `! ${cmd}`]);
    // An interactive login shell (your PATH, a prompt to answer) that stays open after.
    run("pane.split", { direction: "down", pane: p.pane, argv: ["/bin/zsh", "-lic", 'cd "$1" && print -r -- "$ $2" && eval "$2"; exec zsh -l', "zsh", p.cwd ?? home(), cmd] });
  }

  runChip(t, p) {
    const mono = settings().font_family ?? "JetBrains Mono";
    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const chip = h_flex().id(`ph-run-${p.pane}`).h(20).px(7).gap(5).flex_none().max_w(280).items_center().rounded(5)
      .bg(t.accent + "1f").text_color(t.accent).text_size(11.5).cursor_pointer().hover((s) => s.bg(t.accent + "33"))
      .child(svg("mods/pane-sandbox/play.svg").size(10).flex_none());
    if (this.cmds.length === 1) {
      const [cmd] = this.cmds;
      return stop(chip).tooltip(this.sandboxed(p) ? `Run outside the sandbox, in a new pane: ${cmd}` : `Run in Claude Code: ! ${cmd}`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.runCmd(p, cmd); cx.notify(); })
        .child(div().min_w(0).truncate().font_family(mono).child(cmd));
    }
    const item = (cmd, i) => stop(h_flex().id(`ph-run-${p.pane}-${i}`).h(26).px(8).gap(7).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.runCmd(p, cmd); cx.notify(); })
      .child(svg("mods/pane-sandbox/play.svg").size(10).flex_none().text_color(t.accent))
      .child(div().min_w(0).truncate().font_family(mono).text_color(t.foreground).child(cmd)));
    return HoverCard.new(`ph-runs-${p.pane}`).open_delay(150).anchor("top_right")
      .trigger(stop(chip).child(`Run (${this.cmds.length})`))
      .content(v_flex().w(380).p(4).gap(1).rounded(10).bg(t.popover).border(1).border_color(t.border).text_size(12)
        .child(div().px(8).pt(4).pb(2).text_size(11).text_color(t.dim)
          .child(this.sandboxed(p) ? "Claude Code asks you to run (outside the sandbox, in a new pane)" : "Claude Code asks you to run"))
        .children(this.cmds.map(item)));
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    // Started from the + menu (new-menu-sandbox): shown as a chat from the start.
    // Once Herdr knows it's Claude Code or Codex: the chat reads that to find its log.
    if (chatty(p) && !p.chat && !this.busy && terminals().find((x) => x.address === p.terminal)?.labels?.["chat.start"]) {
      hc(["label", p.terminal, "chat.start="]);
      this.swap(() => toChat(p));
    }
    this.look(p, cx);
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      // In Chat mode the chat's code blocks have their own Run (mods/chat runBangs()).
      .when(this.cmds.length > 0 && st !== "working" && !p.chat, (el) => el.child(this.runChip(t, p)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(Boolean(p.chat), el => el.child(div().id(`ph-find-${pane}`).size(22).flex_none().flex().items_center().justify_center().rounded(4)
        .cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Find in chat (⌘F / Ctrl+F)").role("button").tab_index(0).accessibility_label("Find in chat")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("pane.focus", { pane });
          setShared("chat.findreq", { pane, at: Date.now() });
        }).child(svg("mods/chat/search.svg").size(14))))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        // A chat pane's agent is parked behind it: Terminal brings it back, so no close here.
        .when(!p.chat, (el) => el.child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane }))))
      .when(chatty(p) || (p.chat && Boolean(p.terminal)), (el) => el.child(this.switcher(t, p)));
  }
}
