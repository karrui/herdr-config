// Finding an agent's own session log and reading it as a conversation.
// Claude Code: ~/.claude/sessions/<pid>.json names the session its process writes, so the
// log is ~/.claude/projects/*/<sessionId>.jsonl. Codex keeps its rollout file open, so the
// file is whatever rollout-*.jsonl its process (or a child) holds. Both are exact: no
// guessing by folder or time, so two agents in one folder never get mixed up.

import { home } from "herdr";

// Internal reviewers and helpers can hold rollouts under the same process tree.
const MAIN = `[ -f "$f" ] && ! head -c 2000 "$f" | grep -Eq '"source"[[:space:]]*:[[:space:]]*\\{[[:space:]]*"subagent"'`;

// Prints the log's path on the agent's machine, or nothing. Args: kind, pid.
export const FIND = `
kind="$1"; pid="$2"
kids() { for k in $(pgrep -P "$1" 2>/dev/null); do echo "$k"; kids "$k"; done; }
for p in "$pid" $(kids "$pid"); do
  if [ "$kind" = claude ]; then
    j="$HOME/.claude/sessions/$p.json"
    [ -f "$j" ] || continue
    id=$(sed -n 's/.*"sessionId":"\\([0-9a-fA-F-]*\\)".*/\\1/p' "$j")
    [ -n "$id" ] || continue
    for f in "$HOME"/.claude/projects/*/"$id".jsonl; do [ -f "$f" ] && { echo "$f"; exit 0; }; done
    echo "pending"; exit 0
  else
    if [ -d "/proc/$p/fd" ]; then
      f=$(for d in /proc/$p/fd/*; do readlink "$d"; done 2>/dev/null | grep '/rollout-.*\\.jsonl$')
    else
      f=$(lsof -p "$p" -Fn 2>/dev/null | sed -n 's/^n//p' | grep '/rollout-.*\\.jsonl$')
    fi
    f=$(printf '%s\\n' "$f" | while IFS= read -r f; do ${MAIN} && { echo "$f"; break; }; done)
    [ -n "$f" ] && { echo "$f"; exit 0; }
  fi
done
true`;

// Reads a log on the agent's machine, sending back only what the chat shows. Each kept line
// comes back as "<offset>\t<kind>\t<data>": J a JSON line (images emptied), R a tool result's
// ids only (outputs stay in the file, fetched when a row is opened), T a call too big to
// send (its tool name). Lines the chat doesn't show (bookkeeping, sealed reasoning, requests) stay.
//   log tail <file> <from>            what was added since byte <from>: "T <size> <from> <end>"
//   log page <file> <before> <want>   about <want> messages ending at byte <before> (or the
//                                     last whole line), going back in growing chunks:
//                                     "P <start> <end>" (start 0: the very start)
//   log results <file> <offset>...    the first 64 KB of the lines at those offsets
export const LOG = String.raw`
mode="$1"; f="$2"
[ -f "$f" ] || { echo "missing"; exit 0; }
s=$(wc -c < "$f" | tr -d ' ')
X='
BEGIN { pos = base; first = base; msgs = 0; mine = side ? "\"isSidechain\":true" : "\"isSidechain\":false" }
{
  off = pos; pos += length($0) + 1
  if (NR == 1 && skip) { first = pos; next }
  line = $0
  head = substr(line, 1, 400)
  claude = index(head, mine) && index(line, "\"type\":\"user\",\"message\"")
  codex = index(head, "\"type\":\"response_item\"")
  # Codex records the actual MCP calls made inside code mode, including dynamic dispatch.
  # Keep only names and status here; results stay at this byte offset for expansion.
  if (index(head, "\"type\":\"event_msg\"") && index(line, "\"type\":\"item_completed\"") && index(line, "\"type\":\"McpToolCall\"")) {
    if (!count) {
      nm = ""; n = split("id server tool status", ks, " ")
      for (k = 1; k <= n; k++) if (match(line, "\"" ks[k] "\":\"[^\"]*")) nm = nm "\037" ks[k] "=" substr(line, RSTART + length(ks[k]) + 4, RLENGTH - length(ks[k]) - 4)
      print off "\tM\t" nm
    }
    next
  }
  if ((claude && index(line, "\"tool_result\"")) || (codex && (index(head, "\"function_call_output\"") || index(head, "\"custom_tool_call_output\"")))) {
    if (count) next
    ids = ""; t = line
    # A call that failed comes back as its id and "!". Claude Code marks the result is_error (a
    # command that exited non-zero, a denied or cancelled call). Codex says so in the header
    # before the output: "Exit code: 1", "Process exited with code 1", a script that failed.
    err = claude && index(line, "\"is_error\":true")
    if (codex) {
      h = substr(line, index(line, "\"output\":"), 400); k = index(h, "Output:"); if (k) h = substr(h, 1, k)
      if (index(h, "Script failed") || (match(h, /(Exit code: |Process exited with code )-?[0-9]+/) && substr(h, RSTART, RLENGTH) !~ / 0$/)) err = 1
    }
    # Claude Code writes is_error before its result id (ponytail: a line of several results in
    # the other order, id first, would mark the wrong one; none failed so in the logs seen).
    while (match(t, /"(tool_use_id|call_id)":"[^"]*"/)) { m = substr(t, RSTART, RLENGTH); sub(/^"[a-z_]*":"/, "", m); sub(/"$/, "", m); if (err && (codex || index(substr(t, 1, RSTART - 1), "\"is_error\":true"))) m = m "!"; ids = ids " " m; t = substr(t, RSTART + RLENGTH) }
    # One result alone: its is_error can come after its id.
    if (err && !index(ids, "!") && split(ids, qq, " ") == 1) ids = ids "!"
    # A helper (or job) launched to run on its own: its result came at once, it is not done yet.
    if (index(line, "Async agent launched") || index(line, "running in background")) ids = ids " ASYNC"
    print off "\tR\t" ids
    # show-your-work names what it kept in its result ("show-your-work:#<id>"): the kept copy,
    # and the id a later version names as the one it revises (S: the id, then the call ids).
    if (claude && match(line, /show-your-work:#[0-9a-f]+/)) print off "\tS\t" substr(line, RSTART + 16, RLENGTH - 16) ids
    # Pictures a tool returned (screens from an MCP server): Claude Code saves each in the session
    # folder (tool-results) and names the file in the line. The chat shows them in a strip (I).
    # (No apostrophes in here: this awk program sits in single quotes.)
    # Found by plain index, not a regex over the line: these lines can be megabytes of base64.
    if (claude && index(line, "/tool-results/")) {
      pics = ""; t = line
      while ((pk = index(t, "/tool-results/")) > 0) {
        ps = pk; while (ps > 1 && pk - ps < 400 && index(" \"[]", substr(t, ps - 1, 1)) == 0) ps--
        pr = substr(t, pk, 300)
        if (match(pr, /^\/tool-results\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|gif)/)) { p = substr(t, ps, pk - ps) substr(pr, 1, RLENGTH); if (!index(pics, p)) pics = pics "\037" p }
        t = substr(t, pk + 14)
      }
      if (pics != "") print off "\tI\t" substr(pics, 2)
    }
    # An answer to a question, or words that declined a request: read whole (answers()).
    if (claude && length(line) <= 262144 && ((index(line, "\"answers\":{") && index(line, "\"questions\":[")) || index(line, "wrote in the chat instead: "))) print off "\tJ\t" line
    next
  }
  keep = 0
  if (index(head, mine)) {
    if (index(line, "\"type\":\"user\",\"message\"") || index(line, "\"type\":\"assistant\",\"uuid\"") || (index(line, "\"type\":\"attachment\",\"uuid\"") && index(line, "\"queued_command\"")) || index(head, "\"subtype\":\"turn_duration\"") || index(head, "\"subtype\":\"compact_boundary\"") || index(head, "\"subtype\":\"api_error\"")) keep = 1
  } else if (index(head, "\"type\":\"response_item\"")) {
    # Reasoning only when it says something: most is encrypted, its summary empty.
    if (index(head, "\"type\":\"message\"") || index(head, "_call\"") || (index(head, "\"type\":\"reasoning\"") && index(line, "\"summary\":[{"))) keep = 1
  } else if (index(head, "\"type\":\"event_msg\"")) {
    if (index(head, "\"task_complete\"") || index(head, "\"turn_aborted\"") || index(head, "\"token_count\"") || index(head, "\"task_started\"") || index(head, "\"ContextCompaction\"")) keep = 1
  } else if (index(head, "\"type\":\"turn_context\"") || index(head, "\"type\":\"queue-operation\"")) {
    keep = 1
  }
  if (!keep) next
  if (index(line, "\"type\":\"text\"") || index(line, "\"role\":\"user\",\"content\":\"") || index(head, "\"type\":\"message\"")) msgs++
  if (count) next
  gsub(/"data":"[^"]*"/, "\"data\":\"\"", line)
  gsub(/"image_url":"data:[^"]*"/, "\"image_url\":\"\"", line)
  if (codex && index(head, "\"type\":\"reasoning\"")) gsub(/"encrypted_content":"[^"]*"/, "\"encrypted_content\":\"\"", line)
  big = (index(line, "\"tool_use\"") || index(head, "_call\"")) ? 32768 : 262144
  if (length(line) > big) {
    nm = ""
    if (match(line, /"name":"[^"]*"/)) nm = substr(line, RSTART + 8, RLENGTH - 9)
    # A call too big to send: its name and its small fields (what the working line says).
    n = split("file_path notebook_path description command pattern url query path activeForm", ks, " ")
    for (k = 1; k <= n; k++) if (match(line, "\"" ks[k] "\":\"[^\"]*")) nm = nm "\037" ks[k] "=" substr(line, RSTART + length(ks[k]) + 4, (RLENGTH - length(ks[k]) - 4 > 200) ? 200 : RLENGTH - length(ks[k]) - 4)
    print off "\tT\t" nm
    next
  }
  print off "\tJ\t" line
}
END { if (first > pos) first = pos; print "#\t" first "\t" msgs }'
# SIDE=1: a helper's own log (main.js transcript), where every line is the sidechain.
range() { tail -c +$(($1 + 1)) "$f" | head -c $(($2 - $1)) | LC_ALL=C awk -v base="$1" -v skip="$3" -v count="$4" -v side="$SIDE" "$X"; }
case "$mode" in
tail)
  o="$3"; [ "$s" -lt "$o" ] && o=0
  part=0
  if [ "$s" -gt "$o" ] && [ "$(tail -c +"$s" "$f" | head -c 1 | wc -l | tr -d ' ')" = 0 ]; then
    part=$(tail -c +$((o + 1)) "$f" | head -c $((s - o)) | LC_ALL=C awk 'END { print length($0) }')
  fi
  e=$((s - part))
  echo "T $s $o $e"
  [ "$e" -gt "$o" ] && range "$o" "$e" 0 0
  ;;
page)
  e="$3"; want="$4"
  if [ "$e" -ge "$s" ]; then
    e="$s"
    if [ "$s" -gt 0 ] && [ "$(tail -c +"$s" "$f" | head -c 1 | wc -l | tr -d ' ')" = 0 ]; then
      e=$((s - $(tail -c 1048576 "$f" | LC_ALL=C awk 'END { print length($0) }')))
    fi
  fi
  a="$e"; b="$e"; n=0; c=1000000
  while [ "$a" -gt 0 ] && [ "$n" -lt "$want" ]; do
    lo=$((b - c)); [ "$lo" -lt 0 ] && lo=0
    k=0; [ "$lo" -gt 0 ] && k=1
    r=$(range "$lo" "$b" "$k" 1 | tail -n 1)
    first=$(echo "$r" | cut -f2); m=$(echo "$r" | cut -f3)
    if [ "$first" -ge "$b" ] && [ "$lo" -gt 0 ]; then c=$((c * 2)); continue; fi
    n=$((n + m)); a="$first"; b="$first"
    [ "$c" -lt 16000000 ] && c=$((c * 2))
  done
  echo "P $a $e"
  [ "$e" -gt "$a" ] && range "$a" "$e" 0 0
  ;;
results)
  shift 2
  for o in "$@"; do printf '\036%s\n' "$o"; tail -c +$((o + 1)) "$f" | head -c 65536 | head -n 1; done
  ;;
esac
true`;


const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const time = (s) => Date.parse(s ?? "") || 0;
// A message's words: its text, or its blocks' texts.
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text ?? "").join("\n") : "");

// Text Claude Code puts in a user line that the person didn't type.
const INJECTED = /^\s*(<(local-command-|system-reminder|bash-|task-notification|user-memory-input|user-prompt-submit-hook|command-message)|Caveat: The messages below|\[Request interrupted)/;
const CODEX_INJECTED = /^\s*(# AGENTS\.md instructions|<(environment_context|user_instructions|user_shell_command|turn_aborted|subagent_notification|skill|INSTRUCTIONS)\b)/;

// What the person typed, without what the CLI or herdr-core wrapped around it.
// A message another agent sent with `hc send` comes as <hc from="t3 name">text</hc>.
// Reactions travel as Herdr tag lines (taught to agents by agent/instructions.md):
//   the person  <hc from="person" reaction="👍" to="first words of the message"/>   (or reaction-removed=)
//   the agent   <hc react="👀" to="first words of the person's message"/>   on a line of its own
//               <hc no-reply/>   a reply that is only this shows nothing (<no-reply> too)
// None of these lines show in the chat; the reactions show on the messages they name.
const TAG = /^<hc((?:\s+[\w-]+="[^"]*")*)\s*\/>$/;
function tagOf(line) {
  const m = TAG.exec(line.trim());
  if (!m) return null;
  const a = {};
  for (const [, k, v] of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[k] = v;
  return a;
}
// A message's start, as a reaction names it: its first words, on one line, quotes made curly.
export function excerpt(text, n = 60) {
  const one = String(text ?? "").replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim().replace(/"/g, "”");
  return one.length > n ? one.slice(0, n - 1).trimEnd() + "…" : one;
}
// Does `text` start with what a reaction's `to` quotes (loose: an agent may shorten it)?
export function names(text, to) {
  const a = excerpt(text, 400).toLowerCase(), b = String(to ?? "").replace(/…$/, "").replace(/"/g, "”").replace(/\s+/g, " ").trim().toLowerCase();
  if (!b) return false;
  return a.startsWith(b) || (b.length >= 12 && a.includes(b.slice(0, 24)));
}

// The person's reaction lines in a message, and the rest of its text.
function reactionLines(t) {
  const reactions = [], rest = [];
  for (const line of String(t).split("\n")) {
    const a = tagOf(line);
    if (a && (a.reaction || a["reaction-removed"])) reactions.push({ emoji: a.reaction ?? a["reaction-removed"], on: Boolean(a.reaction), to: a.to ?? "" });
    else rest.push(line);
  }
  return { reactions, text: rest.join("\n").trim() };
}

// A reply from the chat: its first line <hc reply-to="first words of the message"/> (older
// replies quoted the message as a "> " blockquote instead; the chat matches those to messages).
function replyOf(t) {
  const lines = String(t).split("\n");
  const a = tagOf(lines[0] ?? "");
  if (a && "reply-to" in a) return { replyTo: a["reply-to"], text: lines.slice(1).join("\n").trim() };
  const m = /^((?:>[^\n]*\n)+)\n*([\s\S]+)$/.exec(String(t));
  if (m) return { quoted: m[1].split("\n").map((l) => l.replace(/^>\s?/, "")).join(" ").trim(), text: m[2].trim() };
  return null;
}

// The annotations' list as notesTag() writes it: "1. "quote"" (or "1. Picture: paths"), then
// "   Their comment: …" when there is one.
function noteItems(body) {
  return String(body).replace(/^The person points at[^\n]*\n/, "").split(/\n(?=\d+\. )/).map((item) => {
    let q = item.replace(/^\d+\. /, "");
    const c = /\n {3}Their comment: ([\s\S]*)$/.exec(q);
    if (c) q = q.slice(0, c.index);
    q = q.trim();
    if (q.startsWith('"') && q.endsWith('"') && q.length > 1) q = q.slice(1, -1);
    return { quote: q, comment: c ? c[1].trim() : "" };
  }).filter((x) => x.quote || x.comment);
}

// A message's words, with the annotations it carries.
function cleanUser(t) {
  let u = cleanWords(t);
  // Annotations (main.js notesTag()): hidden like Herdr's other tags, counted under the words,
  // each { quote, comment } to show when the count is clicked.
  const tag = /<herdr-annotations n="(\d+)">\n?([\s\S]*?)<\/herdr-annotations>/.exec(t);
  if (tag) u = { ...(u ?? { text: "" }), notes: Number(tag[1]), noteItems: noteItems(tag[2]) };
  return u;
}

function cleanWords(t) {
  // A ! command run in Claude Code (the chat's Run, or typed in its terminal): yours, so it starts
  // a turn, with its output added to it when that line comes (Conversation.user()).
  const bi = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/.exec(t);
  if (bi) return { text: "`! " + bi[1].trim().replace(/`/g, "'") + "`", bang: true };
  const bo = /^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/.exec(t);
  if (bo) return { text: "", bangOut: [bo[1], bo[2]].filter((x) => x?.trim()).join("\n").trim() };
  const r = reactionLines(t);
  if (r.reactions.length) {
    const u = r.text ? cleanWords(r.text) : null;
    return { ...(u ?? { text: "" }), reactions: r.reactions };
  }
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1] ?? "";
    // The model picker's effort change types /effort (main.js setEffort()): not the person's.
    if (cmd[1].trim() === "/effort" && !args.trim()) return null;
    return { text: `${cmd[1].trim()} ${args.trim()}`.trim() };
  }
  if (INJECTED.test(t)) return null;
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<\/?pasted_content\b[^>]*>\n?/g, "")
    // Herdr's own tags for the agent (<herdr-annotations>, ...), wherever they are in a
    // message: never shown, the words typed around them are.
    .replace(/<(herdr-[\w-]+)\b[^>]*>[\s\S]*?<\/\1\s*>\n?/g, "").replace(/<herdr-[\w-]+\b[^>]*\/>\n?/g, "").trim();
  if (!t) return null;
  // Herdr's own wrapper (other attributes may follow from=, e.g. reach="…").
  const hc = /^<hc\b([^>]*)>([\s\S]*?)<\/hc>$/.exec(t);
  if (hc) {
    const from = /\bfrom="([^"]*)"/.exec(hc[1])?.[1];
    // An artifact's form (mods/artifacts) says which one: "Message from Coverage". Else the
    // whole from= ("t7 reviewer"): the chat names the sender from it (main.js sender()).
    const title = from === "artifact" ? /\btitle="([^"]*)"/.exec(hc[1])?.[1] : null;
    return from ? { text: hc[2].trim(), from: title || from } : null;
  }
  // A message that is one tag from end to end was written by a program, not typed.
  if (/^<([a-z][\w-]*)\b[^>]*>[\s\S]*<\/\1>$/.test(t)) return null;
  // A quote (a reply from the chat) ends where the typed text starts: the CLI may have joined them.
  t = t.replace(/^(>.*)\n(?!>|\n)/gm, "$1\n\n");
  const reply = replyOf(t);
  if (reply?.replyTo !== undefined) return { text: reply.text, replyTo: reply.replyTo };
  if (reply?.quoted) return { text: t, quoted: reply.quoted, rest: reply.text };
  return t ? { text: t } : null;
}

function claudeUser(c) {
  if (typeof c === "string") return cleanUser(c);
  if (!Array.isArray(c) || c.some((b) => b?.type === "tool_result")) return null;
  // Images sent with the message (Claude Code turns an image path into one): counted, and the
  // "[Image #1]" markers it leaves in the text go.
  const images = c.filter((b) => b?.type === "image").length;
  const parts = c.filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => cleanUser(images ? b.text.replace(/\[Image #\d+\]\s*/g, "") : b.text)).filter(Boolean);
  if (!parts.length) return images ? { text: "", images } : null;
  const reactions = parts.flatMap((p) => p.reactions ?? []);
  return { text: parts.map((p) => p.text).filter(Boolean).join("\n\n"), from: parts[0].from, images, reactions, notes: parts[0].notes, noteItems: parts[0].noteItems,
    replyTo: parts[0].replyTo, quoted: parts[0].quoted, rest: parts[0].rest };
}

const short = (p) => {
  const s = String(p ?? "");
  const parts = s.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : s;
};
// Text Herdr can draw: a cut (a slice, a log line cut at 64 KB) can leave half of an emoji's
// surrogate pair, which isn't valid UTF-8 and fails the whole view. It becomes U+FFFD.
export const whole = (s) => String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
const clip = (s, n = 90) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return whole(s.length > n ? s.slice(0, n - 1) + "…" : s); };

// A compaction in words: "Context compacted · 838k → 30k tokens", "Context compacted
// automatically at 369k tokens" (an automatic one often says only its size before).
function compactWords(auto, pre, post) {
  const k = (n) => (n >= 999500 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.max(1, Math.round(n / 1000))}k`);
  const how = auto ? "Context compacted automatically" : "Context compacted";
  return pre > 0 && post > 0 ? `${how} · ${k(pre)} → ${k(post)} tokens` : pre > 0 ? `${how} at ${k(pre)} tokens` : how;
}
// What a Codex reasoning summary is on about, for the working line: its bold heading, else its
// first sentence.
function gist(text) {
  const t = String(text ?? "").trim();
  const head = t.match(/^\*\*([^*\n]+)\*\*/)?.[1];
  return clip(head ?? t.replace(/[*_`#]/g, "").split(/(?<=[.!?])\s/)[0], 60);
}

// A command that publishes an artifact (mods/artifacts): the chat shows a card for it, found in
// the artifacts' registry by who published it and when.
const ARTIFACT = /\bherdr-artifact\b[^\n|;&]*\b(publish|update)\b/;

// One tool call in words: its kind (for the summary) and a line for the open row.
// A command that only waits (hc wait, sleep): what it waits for, in words; else null. While
// it runs the agent is waiting, not busy: a message wakes it (hc wait returns on one).
function waitWords(command, description) {
  const w = /(?:^|[;&|(]\s*)(hc\s+wait\b[^;&|)]*|sleep\s+\d+)/.exec(String(command ?? ""));
  if (!w) return null;
  if (description) return description;
  if (/--children/.test(w[1])) return "Waiting for workers";
  const who = /hc\s+wait\s+([^\s-][^\s]*)/.exec(w[1])?.[1];
  return who ? `Waiting for ${who}` : "Waiting";
}

// A command in a few words: "bun test", "git status".
const cmdWords = (c) => clip(String(c ?? "").replace(/^(cd [^&;]+(&&|;)\s*)+/, "").split(/\s*(?:&&|\|\||;|\|)\s*/)[0], 48);
const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return clip(u, 40); } };

// An edit as the chat shows it: { file, add, del, lines: [{ t: "+" | "-" | " " | "@", s }] }, "@"
// where unchanged lines are left out. Lines changed are kept with 3 around them, at most 400.
const DIFF_MAX = 400;
function lineDiff(a, b) {
  const A = String(a ?? "").split("\n"), B = String(b ?? "").split("\n");
  if (A.length * B.length > 250000) return [...A.map((s) => ({ t: "-", s })), ...B.map((s) => ({ t: "+", s }))];
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: " ", s: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: "-", s: A[i++] });
    else out.push({ t: "+", s: B[j++] });
  }
  while (i < n) out.push({ t: "-", s: A[i++] });
  while (j < m) out.push({ t: "+", s: B[j++] });
  return out;
}
function diffOf(file, lines) {
  const near = lines.map((l, i) => l.t !== " " || lines.slice(Math.max(0, i - 3), i + 4).some((x) => x.t === "+" || x.t === "-"));
  const kept = [];
  let gap = false;
  lines.forEach((l, i) => { if (near[i] && l.t !== "@") { if (gap && kept.length) kept.push({ t: "@", s: "" }); gap = false; kept.push(l); } else gap = true; });
  return { file, add: lines.filter((l) => l.t === "+").length, del: lines.filter((l) => l.t === "-").length, lines: kept.slice(0, DIFF_MAX), more: Math.max(0, kept.length - DIFF_MAX) };
}
function claudeDiffs(name, input) {
  const f = input.file_path;
  if (!f) return [];
  if (name === "Edit") return [diffOf(f, lineDiff(input.old_string, input.new_string))];
  if (name === "MultiEdit") return [diffOf(f, (input.edits ?? []).flatMap((e, k) => [...(k ? [{ t: "@", s: "" }] : []), ...lineDiff(e.old_string, e.new_string)]))];
  // (A Write too big to send comes without its content: no diff, rather than a "+1".)
  if (name === "Write") return input.content === undefined ? [] : [diffOf(f, String(input.content).split("\n").map((s) => ({ t: "+", s })))];
  return [];
}
// Codex's apply_patch: a diff per file it touches.
function patchDiffs(patch) {
  const out = [];
  let cur = null;
  for (const l of String(patch ?? "").split("\n")) {
    const f = /^\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(l);
    if (f) { cur = { file: f[1].trim(), lines: [] }; out.push(cur); continue; }
    if (!cur || /^\*\*\* /.test(l)) continue;
    if (l.startsWith("@@")) cur.lines.push({ t: "@", s: "" });
    else if (/^[+\- ]/.test(l)) cur.lines.push({ t: l[0], s: l.slice(1) });
  }
  return out.map((d) => diffOf(d.file, d.lines));
}

// One tool call in words: its kind (for the summary), a line for the open row, and what it is
// doing (for the working line: "Editing main.js", "Run the auth tests").
function claudeStep(name, input = {}) {
  const st = claudeStepOnly(name, input);
  if (st?.kind === "edit") st.diffs = claudeDiffs(name, input);
  return st;
}
function claudeStepOnly(name, input = {}) {
  switch (name) {
    case "Read": return { kind: "read", line: `Read ${short(input.file_path)}`, doing: `Reading ${base(input.file_path)}` };
    case "Edit": case "MultiEdit": case "NotebookEdit":
      return { kind: "edit", line: `Edited ${short(input.file_path ?? input.notebook_path)}`, doing: `Editing ${base(input.file_path ?? input.notebook_path)}` };
    case "Write": return { kind: "edit", line: `Wrote ${short(input.file_path)}`, doing: `Writing ${base(input.file_path)}` };
    case "Bash": {
      const line = input.description ? `${input.description}: ${clip(input.command, 80)}` : `Ran ${clip(input.command, 80)}`;
      // The open row shows the description, then the command in the terminal's font.
      const cmd = { label: input.description || "Ran", cmd: String(input.command ?? "").split("\n")[0] };
      // A job left running in the background: the turn goes on; the chat watches the job.
      if (input.run_in_background) return { kind: "run", line, ...cmd, doing: `Started ${input.description || cmdWords(input.command)}`,
        bg: { label: input.description || cmdWords(input.command), cmd: String(input.command ?? ""), kind: "job" } };
      const wait = waitWords(input.command, input.description);
      return { kind: "run", line, ...cmd, doing: wait ?? (input.description || `Running ${cmdWords(input.command)}`), waiting: Boolean(wait) };
    }
    // A monitor runs on after the call, as a background job does, until its last notice.
    case "Monitor": return { kind: "tool", line: `Watched ${clip(input.description ?? input.command, 70)}`,
      doing: `Watching ${clip(input.description ?? input.command ?? "", 50)}`.trim(), waiting: true,
      bg: { label: input.description || cmdWords(input.command), cmd: String(input.command ?? ""), kind: "monitor" } };
    case "Grep": return { kind: "search", line: `Searched for “${clip(input.pattern, 50)}”`, doing: `Searching for “${clip(input.pattern, 40)}”` };
    case "Glob": return { kind: "search", line: `Looked for ${clip(input.pattern, 60)}`, doing: `Looking for ${clip(input.pattern, 40)}` };
    case "WebSearch": return { kind: "web", line: `Searched the web for “${clip(input.query, 60)}”`, doing: `Searching the web for “${clip(input.query, 40)}”` };
    case "WebFetch": return { kind: "web", line: `Opened ${clip(input.url, 80)}`, doing: `Reading ${host(input.url)}` };
    // A helper it waits on (one launched to run on its own answers at once: then the call is over).
    case "Agent": case "Task": return { kind: "agent", line: `Asked a helper: ${clip(input.description, 70)}`,
      doing: input.description ? `Waiting for helper: ${clip(input.description, 50)}` : "Waiting for a helper", waiting: true };
    case "TodoWrite": {
      const now = (Array.isArray(input.todos) ? input.todos : []).find((x) => x?.status === "in_progress");
      return { kind: "plan", line: "Updated its plan", doing: clip(now?.activeForm || now?.content, 60) || "Planning" };
    }
    case "TaskCreate": case "TaskUpdate": return { kind: "plan", line: "Updated its plan", doing: clip(input.activeForm, 60) || "Planning" };
    case "AskUserQuestion": return null;
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) return { kind: "mcp", line: `Used ${mcp[1]}: ${mcp[2]}`, doing: `${mcp[2].replace(/[_-]+/g, " ")} (${mcp[1]})` };
  return { kind: "tool", line: `Used ${name}`, doing: input.description ? clip(input.description, 60) : `Using ${name}` };
}

function codexStep(name, args) {
  let a = args;
  if (typeof a === "string") a = parse(a) ?? { input: a };
  a = a ?? {};
  if (name === "shell" || name === "exec_command" || name === "local_shell" || name === "container.exec") {
    const cmd = Array.isArray(a.command) ? a.command.join(" ") : a.cmd ?? a.command ?? "";
    const plain = String(cmd).replace(/^(bash|sh|zsh) -l?c /, "");
    const wait = waitWords(plain);
    return { kind: "run", line: `Ran ${clip(plain, 80)}`, doing: wait ?? `Running ${cmdWords(plain)}`, waiting: Boolean(wait) };
  }
  if (name === "exec") {
    // Code mode: a script that runs commands (tools.exec_command({cmd: "..."})) and edits files
    // (tools.apply_patch("..."), its patch a JS string literal), or calls MCP tools. Its calls stay in order.
    const src = String(a.input ?? args ?? "");
    const parts = [];
    // These preliminary labels are replaced by the recorded MCP execution events.
    for (const m of src.matchAll(/exec_command\(\{\s*cmd:\s*"((?:[^"\\]|\\.)*)"|apply_patch\(\s*("(?:[^"\\]|\\.)*")\s*\)|\btools\.(mcp__[A-Za-z0-9_]+)\s*\(/g)) {
      if (m[1] !== undefined) { const c = m[1].replace(/\\"/g, '"'); parts.push({ kind: "run", line: `Ran ${clip(c, 80)}`, count: 1, cmd: c }); continue; }
      if (m[3]) { parts.push({ ...claudeStepOnly(m[3]), count: 1 }); continue; }
      let patch = null;
      try { patch = JSON.parse(m[2]); } catch {}
      const diffs = patch ? patchDiffs(patch) : [];
      if (diffs.length) parts.push({ kind: "edit", line: `Edited ${diffs.map((d) => short(d.file)).join(", ")}`, count: diffs.length, diffs });
    }
    if (!parts.length) return { kind: "run", line: "Ran a script", doing: "Running a script" };
    const last = parts[parts.length - 1];
    const doing = last.kind === "edit" ? `Editing ${last.diffs.map((d) => base(d.file)).slice(0, 3).join(", ")}` : last.doing ?? `Running ${cmdWords(last.cmd)}`;
    return { ...parts[0], line: parts.map((p) => p.line).join("\n"), doing, count: parts.reduce((n, p) => n + p.count, 0), parts: parts.length > 1 ? parts : null };
  }
  if (name.startsWith("mcp__")) return claudeStepOnly(name, a);
  if (name === "apply_patch") {
    const files = [...String(a.input ?? args ?? "").matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => short(m[1]));
    return { kind: "edit", line: files.length ? `Edited ${files.join(", ")}` : "Edited files", doing: files.length ? `Editing ${files.map(base).slice(0, 3).join(", ")}` : "Editing files", count: Math.max(1, files.length),
      diffs: patchDiffs(a.input ?? args) };
  }
  if (name === "web_search" || name === "web.run") return { kind: "web", line: "Searched the web", doing: "Searching the web" };
  if (name === "update_plan") return { kind: "plan", line: "Updated its plan", doing: "Planning" };
  if (name === "spawn_agent") {
    // Newer Codex seals the helper's message ("gAAAAA…"): then its task_name says what it's for.
    const task = a.task ?? [a.message, a.prompt].find((m) => m && !/^gAAAAA/.test(m)) ?? String(a.task_name ?? "").replace(/_/g, " ");
    return { kind: "agent", line: `Asked a helper: ${clip(task, 70)}`, doing: "Starting a helper", spawn: clip(task || "a helper", 60), model: a.model ?? null, effort: a.reasoning_effort ?? null };
  }
  if (name === "wait_agent") return { kind: "agent", line: "Waited for helpers", doing: "Waiting for helpers", waiting: true };
  return { kind: "tool", line: `Used ${name}`, doing: `Using ${name}` };
}

// show-your-work's tools (an MCP server or a plugin's): show_image, show_video.
const SHOW = /show[-_]your[-_]work__show_(image|video)$/;
// One of its calls, as its player shows it (each field as its tool describes it): the picture or
// clip (video), what it's compared with, what changed (at: the second, in a clip), its QA
// summary and a clip's checks, earlier versions handed in (versions), the one it revises
// (previous: an #id an earlier result named), links (url, pr). cwd: where the agent ran, where
// the plugin keeps its copies. Fields come as the model sent them, so each is checked.
export function showOf(name, a, cwd = null) {
  const list = (v) => { if (typeof v === "string") { try { v = JSON.parse(v); } catch { return []; } } return Array.isArray(v) ? v : []; };
  const objs = (v) => list(v).filter((x) => x && typeof x === "object");
  const str = (v) => (v == null || String(v).trim() === "" ? undefined : String(v).trim());
  const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const checks = (v) => objs(v).map((c) => ({ name: String(c.name ?? ""), ok: c.ok === true, at: num(c.at), step: str(c.step), expected: str(c.expected), actual: str(c.actual) })).filter((c) => c.name);
  const versions = typeof a.versions === "string" && !a.versions.trim().startsWith("[") ? [a.versions] : list(a.versions);
  return {
    path: String(a.path), compare: str(a.compare), video: /video$/.test(name), cwd: cwd ?? null,
    title: String(a.title ?? "").trim(), label: str(a.label), compareLabel: str(a.compare_label),
    changes: objs(a.changes).map((c) => ({ title: String(c.title ?? "").trim(), detail: str(c.detail), at: num(c.at), url: str(c.url) })).filter((c) => c.title),
    changesTitle: str(a.changes_title),
    summary: objs(a.summary).map((x) => ({ label: String(x.label ?? "").trim(), ok: x.ok === true, passed: num(x.passed), total: num(x.total) })).filter((x) => x.label),
    checks: checks(a.checks), compareChecks: checks(a.compare_checks),
    versions: versions.map((v) => (typeof v === "string" ? { path: v } : v && typeof v === "object" && typeof v.path === "string" ? { path: v.path, note: str(v.note) } : null)).filter(Boolean),
    previous: str(a.previous)?.replace(/^#/, "").toLowerCase(), url: str(a.url), pr: str(a.pr),
  };
}
// Pictures a reply points at by path, as Markdown images: ![what](/abs/path.png).
export function pictures(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/!\[[^\]]*\]\((\/[^)\s]+\.(?:png|jpe?g|gif|webp|mp4|mov|webm))\)/gi)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// The conversation in one log, built from LOG's records ({ off, kind, data }) in file order.
// Items (ids come from byte offsets, so they stay the same when earlier pages are added):
//   { kind: "user", id, text, from?, at, images, paths?, steer }   { kind: "agent", id, text, at, mid? }
//   (images: how many were sent; paths: where the ones Claude Code read from files came from;
//   replyTo: the start of the message it answers; steer: it came while the turn was under way)
//   { kind: "mark", id }  (a message of only reactions: ends the turn, shows nothing)
//   { kind: "tools", id, steps: [{ id, kind, line, out?, failed?, files }] }  (calls in a row,
//                                             between texts; out: where the call's result line is)
//   { kind: "ask", id, text, closed? }  (the agent's own question tool; closed once its dialog
//                                          is gone: "answered" | "dismissed" | "ended" (Codex's))
//   { kind: "error", id, text, retry? }  (retry: the API call is being tried again)
//   { kind: "turnend", id, at?, stopped? }  (stopped: the person stopped the turn)
//   { kind: "compacted", id, text, at }  (the context was compacted: how, in words)
//   { kind: "plan", id, steps: [{ text, status, active? }], text }  (the turn's checklist, its
//                                             latest state; status: pending | in_progress | completed)
//   { kind: "shots", id, at, ...showOf(), history: [{ paths, note? }], note, mark?, kept?, newer? }
//                                            (show-your-work's card: shown(), kept())
// `doing` is what it does right now (the last call not answered yet), for the status line.
// `meta` is what the agent runs on, from its newest lines: { model, effort, speed, used, window }
// (used: tokens in its context window now; window: that window's size when the log says it;
// at: when the model was last named).
export class Conversation {
  constructor(kind, { side = false } = {}) {
    this.kind = kind;
    this.side = side;
    this.items = [];
    this.replies = new Map();
    this.calls = new Map();
    this.open = new Map();
    this.doing = null;
    this.meta = {};
    // Reactions by message id: [{ emoji, by: "you" | "agent" }].
    this.reactions = new Map();
    // Calls that only wait, while open (`waiting`: the newest open call is one); and the jobs
    // the agent left running in the background ({ id, label, cmd }; the chat checks they run).
    this.waits = new Set();
    this.waiting = false;
    this.bg = [];
    // Claude Code's own helpers (Agent/Task calls) by call id: { desc, done }. One launched to
    // run on its own is done when its task-notification comes.
    this.helpers = new Map();
    this.questions = new Map();
    // Messages Claude Code holds until it can take them (typed mid-turn), from its
    // queue-operation lines: { id, raw, text, at }. Taken, they come back as messages. (Those
    // typed while it compacts are queued with no words: main.js shows the chat's own copy.)
    this.queued = [];
    // A /compact running (it ends at the log's compact_boundary).
    this.compacting = false;
    // The error row of a request being retried, while it is: updated in place, gone once the
    // agent goes on (resume()), the error itself if it gives up (failed()).
    this.retry = null;
    // This turn's checklist, updated in place (planned()); and Codex's count of a context just
    // compacted (token_count), for its divider.
    this.plan = null;
    this.recount = null;
    // The turn is under way: the agent has acted and not finished (its last call is out, or
    // Codex's turn has had steps). A message of yours now steers it.
    this.mid = false;
  }

  retrying(off, text) {
    if (!this.retry) this.push(this.retry = { kind: "error", id: `e${off}`, retry: true });
    this.retry.text = text;
  }

  resume() {
    if (!this.retry) return;
    const i = this.items.indexOf(this.retry);
    if (i >= 0) this.items.splice(i, 1);
    this.retry = null;
  }

  failed(off, text) {
    if (this.retry) Object.assign(this.retry, { text, retry: false });
    else this.push({ kind: "error", id: `e${off}`, text });
    this.retry = null;
  }

  push(item) {
    // A new turn gets a checklist of its own (a steer goes on with the same one).
    if ((item.kind === "user" && !item.steer) || item.kind === "turnend") this.plan = null;
    this.items.push(item);
  }

  // The turn's checklist (TodoWrite, update_plan): one card, each update its latest state. The
  // step under way is what the working line says.
  planned(off, steps) {
    const text = steps.map((s) => s.text).join("\n");
    if (this.plan) Object.assign(this.plan, { steps, text });
    else this.push(this.plan = { kind: "plan", id: `p${off}`, steps, text });
    const now = steps.find((s) => s.status === "in_progress");
    if (!this.open.size) this.doing = clip(now?.active || now?.text, 60) || "Planning";
  }

  // Tool calls in a row join the last item when it is a tools row.
  step(id, off, st, helper = null) {
    if (!st) return;
    this.resume();
    // A Codex code-mode script's calls, in the order it made them (codexStep()): its commands
    // and its edits' diff cards interleave as Codex shows them. The call's result goes with its
    // last part, which is the one the working line follows.
    if (st.parts) {
      st.parts.forEach((p, k) => {
        if (k === st.parts.length - 1) { this.step(id, off, { ...st, ...p, diffs: p.diffs ?? null, parts: null }, helper); return; }
        const last = this.items[this.items.length - 1];
        const s = { id: `${id}:${k}`, kind: p.kind, line: p.line, label: p.label, cmd: p.cmd, count: p.count ?? 1, script: st.script, helper, files: (p.diffs ?? []).map((d) => d.file) };
        if (last?.kind === "tools") last.steps.push(s);
        else this.push({ kind: "tools", id: `t${off}:${k}`, steps: [s] });
        (p.diffs ?? []).forEach((d, j) => { if (d.add || d.del) this.push({ kind: "diff", id: `d${off}:${id}:${k}:${j}`, ...d }); });
      });
      return;
    }
    const last = this.items[this.items.length - 1];
    // (files: what an edit touched, for the summary's count.)
    const s = { id, kind: st.kind, line: st.line, label: st.label, cmd: st.cmd, count: st.count ?? 1, script: st.script, helper, files: (st.diffs ?? []).map((d) => d.file) };
    if (last?.kind === "tools") last.steps.push(s);
    else this.push({ kind: "tools", id: `t${off}`, steps: [s] });
    this.calls.set(id, s);
    this.open.set(id, st.doing);
    if (st.waiting) this.waits.add(id);
    if (st.bg) this.bg = [...this.bg.slice(-20), { id, ...st.bg }];
    // An edit's diff: a card of its own under the step (the next step starts a new tools row).
    (st.diffs ?? []).forEach((d, k) => { if (d.add || d.del) this.push({ kind: "diff", id: `d${off}:${id}:${k}`, ...d }); });
    if (this.open.size > 50) this.open.delete(this.open.keys().next().value);
    this.doing = st.doing;
    this.waiting = Boolean(st.waiting);
  }

  // The agent's own question, by its call id: once the call has its result the dialog is gone,
  // answered or not (`closed`: "answered" | "dismissed").
  asked(id, item) {
    this.push(item);
    this.questions.set(id, item);
    if (this.questions.size > 20) this.questions.delete(this.questions.keys().next().value);
  }

  done(id, off, failed = false) {
    const q = this.questions.get(id);
    // (Codex's log doesn't say whether its question got an answer: the chat's line for the
    // card does, main.js askEnded().)
    if (q) q.closed ??= this.kind === "codex" ? "ended" : "dismissed";
    const s = this.calls.get(id);
    if (s) { s.out = off; s.failed = failed; this.calls.delete(id); }
    this.waits.delete(id);
    if (!this.open.delete(id)) return;
    this.doing = this.open.size ? [...this.open.values()].pop() : null;
    this.waiting = this.open.size ? this.waits.has([...this.open.keys()].pop()) : false;
  }

  user(id, u) {
    this.waiting = false;
    // A ! command's output: in a code block under the command it came from.
    if (u?.bangOut !== undefined) {
      const cmd = [...this.items].reverse().find((x) => x.kind === "user" && x.bang && !x.out);
      if (cmd) { const o = u.bangOut.length > 4000 ? `${u.bangOut.slice(0, 3999)}…` : u.bangOut; cmd.out = true; cmd.text += `\n\n\`\`\`\n${o || "(no output)"}\n\`\`\``; }
      return;
    }
    for (const r of u?.reactions ?? []) this.react("you", r);
    // Only reactions: nothing to show, but the agent's turn before it is over (its actions and
    // pills stay while it answers, and its answer is a turn of its own).
    if (!u?.text && !u?.images && !u?.notes) { if (u?.reactions?.length) this.push({ kind: "mark", id }); return; }
    // A reply names the message it answers. An old blockquote reply counts when it matches an
    // earlier message's start; else it stays a quote.
    let text = u.text, replyTo = u.replyTo ?? null;
    if (u.quoted && this.items.some((x) => (x.kind === "user" || x.kind === "agent") && x.text && names(x.text, u.quoted.slice(0, 60)))) {
      replyTo = u.quoted;
      text = u.rest;
    }
    // Claude Code writes the /compact line again once it's done, dated from before: once is enough.
    const compact = /^\/compact\b/.test(text ?? "");
    if (compact && u.at && this.compactedAt >= u.at) return;
    this.push({ kind: "user", id, text, paths: u.paths, replyTo, from: u.from, at: u.at, images: u.images || 0, notes: u.notes || 0, noteItems: u.noteItems, bang: u.bang, steer: this.mid });
    this.doing = null;
    const said = String(text ?? "").replace(/\s+/g, " ").trim();
    if (said) this.queued = this.queued.filter((q) => !said.includes(q.text.replace(/\s+/g, " ").trim()));
    if (compact) { this.compacting = true; this.doing = "Compacting conversation"; }
  }

  // A task-notification: the helper (or background job) its tool-use-id names is done.
  finished(text) {
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
    if (!id) return;
    const h = this.helpers.get(id);
    if (h) h.done = true;
    this.bg = this.bg.filter((j) => j.id !== id);
  }

  // The helpers still running: [{ desc }]. One silent for three hours is taken as gone (its
  // session ended without telling).
  running() {
    const old = Date.now() - 3 * 3600000;
    return [...this.helpers.entries()].filter(([, h]) => !h.done && (!h.at || h.at > old)).map(([id, h]) => ({ id, ...h }));
  }

  // What the person wrote to answer the agent, as their own message right after its question:
  // a question's answer in their words (an option picked on the card is not a message), or the
  // words that declined a request (mods/chat cards.js replyWith()).
  answers(l, off) {
    const at = time(l.timestamp);
    const said = [];
    const r = l.toolUseResult;
    if (r && typeof r === "object" && r.answers && typeof r.answers === "object") {
      const qs = Array.isArray(r.questions) ? r.questions : [];
      for (const [q, a] of Object.entries(r.answers)) {
        const labels = (qs.find((x) => x?.question === q)?.options ?? []).flatMap((o) => {
          const l = String(o?.label ?? o).trim();
          return [l, l.replace(/\s*\(recommended\)\s*$/i, "")];
        });
        const picked = String(a ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        if (a && !(picked.length && picked.every((x) => labels.includes(x)))) said.push(String(a).trim());
      }
    }
    for (const b of l.message.content) {
      if (b?.type !== "tool_result") continue;
      // Its question got an answer: picked, written, or words from the chat (not dismissed).
      const q = this.questions.get(String(b.tool_use_id ?? ""));
      if (q) q.closed = "answered";
      const c = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => x?.text ?? "").join("\n") : "";
      const m = /wrote in the chat instead: ([\s\S]*)$/.exec(c);
      if (m && m[1].trim()) said.push(m[1].trim());
    }
    if (said.length) { this.waiting = false; this.push({ kind: "user", id: `ua${off}`, text: said.join("\n\n"), at, answer: true }); }
  }

  // A reaction lands on the latest message its `to` names: any message for the person's
  // reactions, the person's for the agent's.
  react(by, r) {
    const kinds = by === "you" ? ["agent", "user"] : ["user"];
    const target = [...this.items].reverse().find((x) => kinds.includes(x.kind) && x.text && names(x.text, r.to));
    if (!target) return;
    const list = (this.reactions.get(target.id) ?? []).filter((x) => !(x.by === by && x.emoji === r.emoji));
    if (r.on !== false) list.push({ emoji: r.emoji, by });
    this.reactions.set(target.id, list);
  }

  // What the agent wrote, without its reaction and no-reply lines (those act instead).
  agentText(text) {
    const out = [];
    for (const line of String(text).split("\n")) {
      const a = tagOf(line);
      if (a?.react) this.react("agent", { emoji: a.react, to: a.to ?? "", on: true });
      // <no-reply> too.
      else if (!(a && "no-reply" in a) && !/^<hc\s+no-reply\s*\/>/.test(line.trim()) && !/^<\/?no-reply\b/.test(line.trim())) out.push(line);
    }
    return out.join("\n").trim();
  }

  // A show-your-work card. One that revises an earlier card (previous) has that card's versions
  // and that card's own picture as its history ({ paths, note }: where it may be, best first),
  // after any handed in. The earlier card learns it was replaced (newer: { id, n }, n the new
  // one's version number). A clip keeps only the version before it (the plugin keeps no more).
  shown(call, item) {
    this.shows ??= new Map();
    this.marked ??= new Map();
    const before = item.previous ? this.marked.get(item.previous) : null;
    // Its file at the same path is this one's picture now: only its kept copy shows it.
    const chain = before ? [...before.history, { paths: [...(before.kept ?? []), ...(before.path !== item.path ? [before.path] : [])], note: before.note }] : [];
    const given = item.versions.map((v) => ({ paths: [v.path], note: v.note }));
    let history = [...given, ...chain.filter((c) => !item.versions.some((v) => c.paths.includes(v.path)))];
    if (item.video) history = history.slice(-1);
    const titles = item.changes.map((c) => c.title);
    item.history = history;
    item.note = titles.length ? titles[0] + (titles.length > 1 ? ` and ${titles.length - 1} more` : "") : item.title;
    if (before) before.newer = { id: item.id, n: history.length + 1 };
    this.shows.set(call, item);
    this.push(item);
  }

  // Its result came: the #id it was kept by, so a later version can name it, and where the kept
  // copy may be (kept: the plugin's .show-your-work in the folder the agent started in, which
  // may be above where it is now), which still holds the picture shown after the file at its
  // path is saved over.
  kept(call, mark) {
    const s = this.shows?.get(call);
    if (!s || !/^[0-9a-f]{4,12}$/.test(mark)) return;
    s.mark = mark;
    const ext = /\.[A-Za-z0-9]{1,5}$/.exec(s.path)?.[0] ?? "";
    const dirs = [];
    for (let d = String(s.cwd ?? "").replace(/\/+$/, ""); d && d !== home() && dirs.length < 4; d = d.replace(/\/[^/]*$/, "")) dirs.push(d);
    s.kept = dirs.map((d) => `${d}/.show-your-work/${mark}${ext}`);
    this.marked.set(mark, s);
  }

  feed(records) {
    for (const r of records) {
      if (r.kind === "S") { const [mark, ...ids] = r.data.split(" ").filter(Boolean); for (const id of ids) this.kept(id.replace(/!$/, ""), mark); continue; }
      // Pictures a tool returned: a strip under its step (main.js "gallery").
      // (A path can come as $HOME/… or ~/…, as the tool's output put it.)
      if (r.kind === "I") { this.push({ kind: "gallery", id: `g${r.off}`, paths: r.data.split("\x1f").filter(Boolean).map((p) => p.replace(/^(\$HOME|~)(?=\/)/, home())) }); continue; }
      if (r.kind === "M") {
        const item = Object.fromEntries(r.data.split("\x1f").filter(Boolean).map((f) => { const i = f.indexOf("="); return [f.slice(0, i), f.slice(i + 1)]; }));
        this.codex({ type: "event_msg", payload: { type: "item_completed", item: { ...item, type: "McpToolCall" } } }, r.off);
        continue;
      }
      if (r.kind === "R") {
        const ids = r.data.split(" ").filter(Boolean);
        const async = ids.includes("ASYNC");
        for (const raw of ids) {
          if (raw === "ASYNC") continue;
          // (A failed call's id ends in "!": LOG.)
          const id = raw.replace(/!$/, "");
          // A helper that answered (not one launched to run on its own) is done.
          const h = this.helpers.get(id);
          if (h && !async) h.done = true;
          this.done(id, r.off, raw.endsWith("!"));
        }
        continue;
      }
      if (r.kind === "T") {
        // A call too big to send whole: its name and small fields ("file_path=…").
        const [name, ...fields] = r.data.split("\x1f");
        const input = Object.fromEntries(fields.map((f) => { const i = f.indexOf("="); let v = f.slice(i + 1); try { v = JSON.parse(`"${v.replace(/\\$/, "")}"`); } catch {} return [f.slice(0, i), v]; }));
        if (name) { this.mid = true; this.step(`big${r.off}`, r.off, claudeStep(name, input) ?? { kind: "tool", line: `Used ${name}`, doing: "Working" }); }
        continue;
      }
      const l = parse(r.data);
      if (!l || typeof l !== "object") continue;
      if (this.kind === "codex") this.codex(l, r.off); else this.claude(l, r.off);
    }
  }

  // Claude Code's queue: enqueue (with the words), remove (those words, taken or edited away),
  // popAll (all of it, back in its prompt to edit). Its dequeue isn't followed: it names no
  // words, and the same message can be queued twice. A message is out of the queue once the
  // log has it (user()), and anything left goes when the turn or the compacting ends.
  queueOp(l, off) {
    const raw = typeof l.content === "string" ? l.content : null;
    const text = raw === null ? "" : claudeUser(raw)?.text ?? "";
    if (l.operation === "enqueue" && text) this.queued.push({ id: `qd${off}`, raw, text, at: time(l.timestamp) });
    else if (l.operation === "remove") this.queued = this.queued.filter((q) => q.raw !== raw);
    else if (l.operation === "popAll") this.queued = [];
  }

  claude(l, off) {
    // A helper's lines, in its parent's log; a helper's own log (side) is all of them.
    if (Boolean(l.isSidechain) !== Boolean(this.side)) return;
    // A request that failed, tried again: "Retrying 2/10 · Connection dropped (ECONNRESET)".
    if (l.type === "system" && l.subtype === "api_error") {
      const e = l.error ?? {};
      this.retrying(off, [`Retrying${l.retryAttempt ? ` ${l.retryAttempt}/${l.maxRetries ?? "?"}` : ""}`, e.formatted ?? e.message].filter(Boolean).join(" · "));
      return;
    }
    if (l.type === "queue-operation") { this.queueOp(l, off); return; }
    // It gave up: why, in place of the retry's row.
    if (l.type === "assistant" && l.isApiErrorMessage) {
      const err = (l.message?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
      if (err) this.failed(off, err);
      this.mid = false;
      return;
    }
    // Anything else: it went on.
    this.resume();
    // A turn ended (written once per turn, also for one no message of yours started, as a
    // helper's report does): the chat folds each turn by these (main.js foldTurns()).
    if (l.type === "system" && l.subtype === "turn_duration") { this.queued = []; this.mid = false; this.push({ kind: "turnend", id: `te${off}`, at: time(l.timestamp) }); return; }
    if (l.type === "system" && l.subtype === "compact_boundary") {
      this.queued = []; this.compacting = false; this.compactedAt = time(l.timestamp); this.doing = null;
      const m = l.compactMetadata ?? {};
      // The context is its compacted size now, until the next reply counts it.
      if (m.postTokens > 0) this.meta = { ...this.meta, used: m.postTokens };
      this.push({ kind: "compacted", id: `cb${off}`, text: compactWords(m.trigger === "auto", m.preTokens, m.postTokens), at: this.compactedAt });
      return;
    }
    const said = l.type === "user" ? textOf(l.message?.content) : "";
    // A helper or a background job finished (Claude Code tells the agent so): it's done.
    if (l.type === "user" && l.origin?.kind === "task-notification") { this.finished(said); return; }
    // You stopped the turn (Esc, or a denied call that ends it): it ends here, stopped.
    if (l.type === "user" && /^\s*\[Request interrupted by user/.test(said)) { this.queued = []; this.mid = false; this.push({ kind: "turnend", id: `te${off}`, at: time(l.timestamp), stopped: true }); return; }
    if (l.type === "user") {
      // After a message with images, Claude Code notes where each came from: the chat shows them.
      if (l.isMeta) {
        const c = l.message?.content;
        const texts = typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text) : [];
        const last = this.items[this.items.length - 1];
        for (const t of texts) {
          const m = /^\[Image: source: (.+)\]$/.exec(String(t ?? "").trim());
          if (m && last?.kind === "user") (last.paths ??= []).push(m[1]);
        }
        return;
      }
      if (l.isCompactSummary || l.isVisibleInTranscriptOnly) return;
      if (Array.isArray(l.message?.content) && l.message.content.some((b) => b?.type === "tool_result")) { this.answers(l, off); return; }
      if (l.origin?.kind && l.origin.kind !== "human") return;
      const u = claudeUser(l.message?.content);
      if (u) this.user(`u${off}`, { ...u, at: time(l.timestamp) });
    } else if (l.type === "attachment" && l.attachment?.type === "queued_command") {
      // A message typed while the agent was busy, taken in mid-turn.
      const a = l.attachment;
      // Newer Claude Code queues a helper's (or job's) task-notification the same way.
      if (a.commandMode === "task-notification" || a.origin?.kind === "task-notification") { this.finished(String(a.prompt ?? "")); return; }
      if (a.commandMode !== "prompt" || (a.origin?.kind && a.origin.kind !== "human")) return;
      const u = claudeUser(a.prompt);
      if (u) this.user(`u${off}`, { ...u, at: time(a.timestamp ?? l.timestamp) });
    } else if (l.type === "assistant") {
      const m = l.message ?? {};
      const id = String(m.id ?? l.uuid);
      if (m.model && m.model !== "<synthetic>") {
        const u = m.usage ?? {};
        const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
        this.meta = { ...this.meta, model: m.model, effort: l.perTurnEffort ?? this.meta.effort, speed: u.speed ?? this.meta.speed, used: used || this.meta.used, at: time(l.timestamp) };
      }
      // A call out (each part of a reply is a line of its own, a call its last): it goes on
      // once the result is in. A reply with no call ends the turn.
      if (Array.isArray(m.content) && m.content.length) this.mid = m.content.some((b) => b?.type === "tool_use");
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "thinking" && !this.open.size) this.doing = "Thinking";
        // Its thinking, when it's written out (not redacted): Claude Code's narration between steps.
        if (b?.type === "thinking" && String(b.thinking ?? "").trim()) this.push({ kind: "thought", id: `th${off}`, text: String(b.thinking).trim(), at: time(l.timestamp) });
        const said = b?.type === "text" ? this.agentText(b.text ?? "") : "";
        if (said) {
          // One reply can be written over several lines with the same id.
          const prev = this.replies.get(id);
          if (prev && this.items[this.items.length - 1] === prev) {
            prev.text += "\n\n" + said;
            const pics = pictures(prev.text);
            if (pics.length) prev.paths = pics;
          }
          else {
            const item = { kind: "agent", id: `a${off}`, text: said, at: time(l.timestamp) };
            const pics = pictures(said);
            if (pics.length) item.paths = pics;
            this.replies.set(id, item);
            if (this.replies.size > 20) this.replies.delete(this.replies.keys().next().value);
            this.push(item);
          }
        } else if (b?.type === "tool_use") {
          if (b.name === "AskUserQuestion") {
            const qs = Array.isArray(b.input?.questions) ? b.input.questions : [];
            const text = qs.map((q) => q?.question).filter(Boolean).join("\n\n");
            if (text) this.asked(String(b.id), { kind: "ask", id: `q${off}`, text });
            this.open.set(b.id, "Asking you something");
            this.doing = "Asking you something";
          } else if (SHOW.test(String(b.name ?? "")) && b.input?.path) {
            // show-your-work's picture or recording: shown in the chat itself, not as a step.
            const s = showOf(String(b.name), b.input, typeof l.cwd === "string" ? l.cwd : null);
            this.shown(String(b.id), { kind: "shots", id: `s${off}`, ...s, paths: [s.path, ...(s.compare ? [s.compare] : [])], at: time(l.timestamp) });
          } else if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) {
            // Its todo list: the turn's checklist, not a step. (TaskCreate and TaskUpdate say
            // one task at a time, by ids only their results give: they stay steps.)
            this.planned(off, b.input.todos.map((x) => ({ text: String(x?.content ?? ""), status: x?.status, active: x?.activeForm })));
          } else {
            // What it was asked to run on (none named: its agent's default or the session's).
            if (b.name === "Agent" || b.name === "Task") this.helpers.set(String(b.id), { desc: String(b.input?.description ?? "a helper"), model: b.input?.model ?? null, effort: b.input?.effort ?? null, done: false, at: time(l.timestamp) });
            this.step(String(b.id), off, claudeStep(String(b.name ?? ""), b.input ?? {}), b.name === "Agent" || b.name === "Task" ? String(b.id) : null);
            // When a job or monitor it left running began (the panel says how long).
            const job = this.bg[this.bg.length - 1];
            if (job?.id === String(b.id)) job.at = time(l.timestamp);
            if (b.name === "Bash" && ARTIFACT.test(String(b.input?.command ?? ""))) this.push({ kind: "artifact", id: `art${off}`, at: time(l.timestamp) });
          }
        }
      }
    }
  }

  codex(l, off) {
    const p = l.payload;
    if (!p || typeof p !== "object") return;
    if (l.type === "response_item") {
      // Its words, reasoning and calls: the turn is under way (its own instructions aren't).
      if (p.type !== "message" || p.role === "assistant") this.mid = true;
      if (p.type === "message" && p.role === "user") {
        const items = Array.isArray(p.content) ? p.content : [];
        const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
        const words = items.map((it, i) => {
          if (it?.type !== "input_text" || typeof it.text !== "string") return "";
          if (Array.isArray(kinds) && kinds.length === items.length) return kinds[i] === "user.text" ? it.text.trim() : "";
          return CODEX_INJECTED.test(it.text) ? "" : it.text.trim();
        }).filter(Boolean).join("\n\n");
        const images = items.filter((it) => it?.type === "input_image" || it?.type === "image");
        const paths = images.map((it) => it.image_url ?? it.path).filter((p) => typeof p === "string" && p.startsWith("/"));
        const text = words.split("\n").filter((line) => {
          if (!/^\/[^\n]+\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(line.trim())) return true;
          paths.push(line.trim()); return false;
        }).join("\n").trim();
        const u = text ? cleanUser(images.length ? text.replace(/\[Image #\d+\]\s*/g, "") : text) : null;
        if (u || images.length || paths.length) this.user(`u${off}`, { ...u, paths: [...new Set(paths)], images: Math.max(images.length, paths.length), at: time(l.timestamp) });
      } else if (p.type === "message" && p.role === "assistant") {
        const words = this.agentText((Array.isArray(p.content) ? p.content : []).filter((it) => it?.type === "output_text" && it.text?.trim()).map((it) => it.text.trim()).join("\n\n"));
        // (mid: the message's id, which its live words carry too: Live.logged().)
        if (words) this.push({ kind: "agent", id: `a${off}`, text: words, at: time(l.timestamp), mid: p.id });
      } else if (p.type === "reasoning") {
        // Its reasoning's summary ("**Heading**", words under it at times): shown as Claude
        // Code's thinking is, and its gist on the working line.
        const parts = (Array.isArray(p.summary) ? p.summary : []).map((s) => String(s?.text ?? "").trim()).filter(Boolean);
        if (!parts.length) return;
        this.push({ kind: "thought", id: `th${off}`, text: parts.join("\n\n"), at: time(l.timestamp) });
        if (!this.open.size) this.doing = gist(parts[parts.length - 1]);
      } else if ((p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") && p.name !== "wait" && p.name !== "sleep") {
        const cid = String(p.call_id ?? p.id ?? `c${off}`);
        // Codex's own questions (Plan mode): answered in its terminal, shown here as asked.
        if (p.name === "request_user_input") {
          let a = p.arguments;
          try { a = typeof a === "string" ? JSON.parse(a) : a; } catch {}
          const text = (Array.isArray(a?.questions) ? a.questions : []).map((q) => [q?.question, ...(Array.isArray(q?.options) ? q.options.map((o) => `- ${o?.label ?? o}`) : [])].filter(Boolean).join("\n")).join("\n\n");
          if (text) this.asked(cid, { kind: "ask", id: `q${off}`, text });
          this.open.set(cid, "Asking you something");
          this.doing = "Asking you something";
          return;
        }
        // Its checklist: the turn's card, not a step.
        if (p.name === "update_plan") {
          const a = typeof p.arguments === "string" ? parse(p.arguments) : p.arguments;
          if (Array.isArray(a?.plan)) { this.planned(off, a.plan.map((x) => ({ text: String(x?.step ?? ""), status: x?.status }))); return; }
        }
        const st = codexStep(String(p.name ?? "shell"), p.arguments ?? p.input ?? p.action);
        this.script = p.name === "exec" ? cid : null;
        if (this.script) st.script = cid;
        // Codex's helpers count as running until its turn ends (its log says no more).
        if (st?.spawn) this.helpers.set(cid, { desc: st.spawn, model: st.model, effort: st.effort, done: false, untilTurn: true });
        this.step(cid, off, st, st?.spawn ? cid : null);
        if (ARTIFACT.test(JSON.stringify(p.arguments ?? p.input ?? p.action ?? ""))) this.push({ kind: "artifact", id: `art${off}`, at: time(l.timestamp) });
      }
    } else if (l.type === "turn_context") {
      this.meta = { ...this.meta, model: p.model ?? this.meta.model, effort: p.effort ?? p.reasoning_effort ?? this.meta.effort, at: time(l.timestamp) };
    } else if (p.type === "token_count") {
      const i = p.info ?? {};
      const last = i.last_token_usage ?? {}, used = last.total_tokens;
      // A count with no request behind it (no tokens in or out): Codex counting the context it
      // just compacted, right before saying so. The size before is the last request's.
      if (used !== undefined) this.recount = !last.input_tokens && !last.output_tokens && used > 0 ? { pre: this.meta.used, post: used } : null;
      this.meta = { ...this.meta, used: used ?? this.meta.used, window: i.model_context_window ?? this.meta.window };
    } else if (p.type === "task_started") {
      this.mid = false;
      // A turn no one's words started: Codex logs a /compact so, and nothing else (its other
      // turns name who started them; older Codex named no one, so it counts only after one did).
      if (p.turn_attribution) this.attributed = true;
      else if (this.attributed) this.user(`u${off}`, { text: "/compact", at: time(l.timestamp) });
    } else if (p.type === "item_completed" && p.item?.type === "McpToolCall") {
      const it = p.item;
      if (!it.id || !it.server || !it.tool) return;
      // Actual execution replaces source-code guesses and the outer script placeholder.
      if (this.script) this.items = this.items.filter((x) => {
        if (x.kind !== "tools") return true;
        x.steps = x.steps.filter((s) => s.script !== this.script || (s.kind !== "mcp" && s.line !== "Ran a script"));
        return x.steps.length > 0;
      });
      const st = { kind: "mcp", line: `Used ${it.server}: ${it.tool}`, doing: `Using ${it.server}: ${it.tool}`, count: 1 };
      const existing = this.items.filter((x) => x.kind === "tools").flatMap((x) => x.steps).find((s) => s.id === it.id);
      if (existing) Object.assign(existing, st, { out: off, failed: it.status === "failed" });
      else this.step(it.id, off, st);
      this.done(it.id, off, it.status === "failed");
    } else if (p.type === "item_completed" && p.item?.type === "ContextCompaction") {
      // A /compact is a turn of its own (task_started); one in a turn someone started is
      // automatic (older Codex names no one: then it isn't known).
      const auto = !this.compacting && this.attributed;
      this.compacting = false;
      this.compactedAt = time(l.timestamp);
      this.doing = null;
      this.push({ kind: "compacted", id: `cb${off}`, text: compactWords(auto, this.recount?.pre, this.recount?.post), at: this.compactedAt });
      this.recount = null;
    } else if (p.type === "task_complete" || p.type === "turn_aborted") {
      this.compacting = false;
      this.mid = false;
      for (const h of this.helpers.values()) if (h.untilTurn) h.done = true;
      this.open.clear();
      this.waits.clear();
      this.waiting = false;
      this.doing = null;
      // A turn that failed (out of credits, the model at capacity) says why. Its retries before
      // that aren't in the log: Codex keeps its stream errors out of rollouts.
      if (p.error?.message) this.failed(off, String(p.error.message));
      // The turn ended: the chat folds by these, as by Claude Code's turn_duration. One you
      // stopped is "interrupted" (a forked helper's copy of its parent's turn ends in one too,
      // but with no completed_at: not a stop).
      this.push({ kind: "turnend", id: `te${off}`, at: time(l.timestamp), stopped: p.type === "turn_aborted" && p.reason === "interrupted" && p.completed_at != null });
    }
  }
}

// Turns LOG's output into its header line and records.
export function records(stdout) {
  const lines = stdout.split("\n");
  const head = lines.shift() ?? "";
  const out = [];
  for (const line of lines) {
    const a = line.indexOf("\t");
    if (a < 1 || line[0] === "#") continue;
    const b = line.indexOf("\t", a + 1);
    if (b < 0) continue;
    out.push({ off: Number(line.slice(0, a)), kind: line.slice(a + 1, b), data: line.slice(b + 1) });
  }
  return { head: head.trim().split(" "), records: out };
}

// A tool's output from the line LOG's `results` sent back for it (possibly cut at 64 KB):
// its first few lines.
// Codex code mode's result: a header part ("Script completed / Wall time / Output:"), then a part
// per call the script made, as JSON ({ output, exit_code }) or plain text: their outputs, in order.
function codeModeOutput(parts) {
  return parts.map((p) => String(p?.text ?? "")).filter((t) => !/^Script completed\b/.test(t)).map((t) => {
    const j = parse(t.trim());
    if (j && typeof j === "object") {
      if ("output" in j) return `${String(j.output ?? "").replace(/\n+$/, "")}${j.exit_code ? `\n(exit ${j.exit_code})` : ""}`;
      return Array.isArray(j.content) ? j.content.map((c) => c?.type === "text" ? c.text : "").filter(Boolean).join("\n") : "";
    }
    return t.trim();
  }).filter(Boolean).join("\n");
}

export function resultText(line, id) {
  let text = null;
  const l = parse(line);
  if (l) {
    const c = l.message?.content;
    if (Array.isArray(c)) {
      const b = c.find((x) => x?.type === "tool_result" && x.tool_use_id === id) ?? c.find((x) => x?.type === "tool_result");
      const v = b?.content;
      text = typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => x?.text ?? "").join("\n") : null;
    }
    if (text === null && l.payload?.item?.result) text = codeModeOutput([{ text: JSON.stringify(l.payload.item.result) }]);
    const o = l.payload?.output;
    if (text === null && o !== undefined) text = typeof o === "string" ? o : Array.isArray(o) ? codeModeOutput(o) : String(o?.output ?? o?.content ?? JSON.stringify(o));
  } else {
    // Cut short: take the first string after its content key, up to the cut.
    const m = /"(?:content|text|output)":"((?:[^"\\]|\\.)*)/.exec(line);
    if (m) { try { text = JSON.parse(`"${m[1].replace(/\\[^"]{0,5}$/, "")}"`); } catch { text = m[1]; } }
  }
  if (text === null) return null;
  const rows = String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  const shown = rows.slice(0, 8).map((r) => (r.length > 160 ? r.slice(0, 159) + "…" : r));
  if (rows.length > 8) shown.push(`… ${rows.length - 8} more lines`);
  return whole(shown.join("\n").trim()) || "(no output)";
}

// The tools row's summary: its two main kinds of step, then how many others: "Ran 3 commands,
// edited 2 files and 4 other actions". Commands and edits come first, then reading, searching
// and helpers, then the rest; the two named keep the order they came in. Edits count files.
const SAY = { run: ["ran a command", "ran # commands"], edit: ["edited a file", "edited # files"], read: ["read a file", "read # files"],
  search: ["searched", "searched # times"], web: ["looked on the web", "looked on the web # times"], agent: ["asked a helper", "asked # helpers"],
  plan: ["updated its plan", "updated its plan"], mcp: ["used an MCP tool", "used # MCP tools"], tool: ["used a tool", "used # tools"] };
export function summary(steps) {
  if (steps.length === 1 && steps[0].kind === "mcp") return steps[0].line;
  const n = {}, first = {}, files = new Set();
  let blind = 0;
  steps.forEach((s, i) => {
    const k = SAY[s.kind] ? s.kind : "tool";
    n[k] = (n[k] ?? 0) + (s.count ?? 1);
    first[k] ??= i;
    // (An edit that names no file, a notebook's, counts as one.)
    if (k === "edit") { if (s.files?.length) s.files.forEach((f) => files.add(f)); else blind += s.count ?? 1; }
  });
  const rank = (k) => (k === "run" || k === "edit" ? 0 : k === "plan" || k === "tool" || k === "mcp" ? 2 : 1);
  const named = Object.keys(n).sort((a, b) => rank(a) - rank(b) || first[a] - first[b]).slice(0, 2).sort((a, b) => first[a] - first[b]);
  const words = named.map((k) => { const c = k === "edit" ? files.size + blind : n[k]; return c === 1 ? SAY[k][0] : SAY[k][1].replace("#", c); });
  const rest = Object.keys(n).filter((k) => !named.includes(k)).reduce((a, k) => a + n[k], 0);
  if (rest) words.push(`${rest} other action${rest === 1 ? "" : "s"}`);
  const s = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0] ?? "";
  return s ? s[0].toUpperCase() + s.slice(1) : "Worked";
}

// ---- live events ------------------------------------------------------------------------------
// What the agent shows as it happens, from Claude Code's hooks (event-hook.sh, which has the
// contract) and Codex's app-server (codex-tap.py): one JSON line each in
// chat-events/<terminal>.jsonl. The log stays the record. These fill in only what it can't say
// yet (compacting, a reply as it streams, an error that ended the turn, a reconnect), after its
// last record, and each goes once the log says the same or the turn is over.

// Reads the events file from byte <from>, at most <cap> bytes of it: "E <size> <from> <more>
// <emptied>", then the bytes. A file shorter than <from> was emptied: read from its start. One
// read to its end past 256 KB is emptied (its writers do that at 1 MB only when no chat reads).
export const EVENTS = String.raw`
f="$1"; o="$2"; cap="$3"
[ -f "$f" ] || { echo "E 0 0 0 0"; exit 0; }
s=$(wc -c < "$f" | tr -d ' ')
[ "$s" -lt "$o" ] && o=0
n=$((s - o)); more=0
[ "$n" -gt "$cap" ] && { n="$cap"; more=1; }
cut=0; [ "$more" = 0 ] && [ "$s" -gt 262144 ] && cut=1
echo "E $s $o $more $cut"
[ "$n" -gt 0 ] && tail -c +$((o + 1)) "$f" | head -c "$n"
[ "$cut" = 1 ] && : > "$f"
true`;

// The first of these Codex rollouts that is a conversation, not a helper's or Codex's reviewer's
// (their first line names them a subagent, near its start).
export const MAIN_ROLLOUT = `for f in "$@"; do ${MAIN} && { echo "$f"; exit 0; }; done; true`;

// A string's size in the file (UTF-8 bytes), as offsets there count.
function bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n++;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; } else n += 3;
  }
  return n;
}

// EVENTS' output: its whole lines and where to read next ({ lines, next, more }). A line still
// being written waits for the next read; one longer than a read (never, by the contract) is skipped.
export function eventLines(stdout) {
  const nl = stdout.indexOf("\n");
  const [tag, , from, more, cut] = (nl < 0 ? stdout : stdout.slice(0, nl)).trim().split(" ");
  if (tag !== "E") return null;
  const data = nl < 0 ? "" : stdout.slice(nl + 1);
  let end = data.lastIndexOf("\n") + 1;
  if (!end && more === "1") end = data.length;
  return { lines: data.slice(0, end).split("\n").filter(Boolean), next: cut === "1" ? 0 : Number(from) + bytes(data.slice(0, end)), more: more === "1" };
}

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
// A reply streaming in, as the chat shows it: without Herdr's tag lines (reactions, no-reply),
// which sit on lines of their own (Conversation.agentText()), half-written ones too.
const streamed = (text) => String(text).split("\n").filter((l) => !/^\s*<(hc\b|\/?no-reply\b)/.test(l)).join("\n").trim();
// Codex's plan steps' states in the checklist's words (Conversation.planned()).
const STEP = { inProgress: "in_progress", in_progress: "in_progress", completed: "completed", pending: "pending" };
// Codex's reconnect ("Reconnecting... 2/5") as Claude Code's retry row says one.
function retryWords(msg) {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(String(msg ?? ""));
  return `Retrying${m ? ` ${m[1]}/${m[2]}` : ""} · ${/network/i.test(String(msg)) ? "Waiting for the network" : "Connection dropped"}`;
}

export class Live {
  constructor(own = null) {
    // The session (Claude Code) or thread (Codex) the log is: only its events count. Others are
    // a helper's, Codex's reviewer's, or an earlier agent's at this address.
    this.own = own;
    // When the latest turn began or ended (events' t): what streamed before it is over.
    this.turnAt = 0;
    // The reply streaming in: { id, start, parts, whole } (whole: seen from its start).
    this.tail = null;
    // Compacting since { at }; an API error that ended the turn { at, text } (Claude Code's
    // StopFailure); a reconnect { at, text } (Codex's); its plan { at, steps } (Codex's).
    this.compact = null;
    this.error = null;
    this.retry = null;
    this.plan = null;
    // Calls auto mode refused (Claude Code's PermissionDenied): call id -> reason.
    this.denied = new Map();
    // Codex rollouts its tap joined, newest last: [{ path, t }] (main.js locate()).
    this.rollouts = [];
  }

  // New lines of the file. Hooks run async, so they go in by when they ran. True when something
  // the chat shows may have changed.
  feed(lines) {
    const evs = lines.map(parse).filter((e) => e && typeof e === "object").sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    let changed = false;
    for (const e of evs) changed = this.apply(e) || changed;
    return changed;
  }

  apply(e) {
    if (e.src === "codex" && e.ev === "joined") {
      if (e.rollout) this.rollouts = [...this.rollouts.filter((r) => r.path !== e.rollout), { path: String(e.rollout), t: e.t }].slice(-20);
      return false;
    }
    if (!this.own || (e.src === "claude-hook" ? e.sid !== this.own || e.agent : e.thread !== this.own)) return false;
    const t = Number(e.t) || 0;
    switch (`${e.src}:${e.ev}`) {
      case "claude-hook:UserPromptSubmit": this.turn(t); this.error = null; return true;
      case "claude-hook:Stop": case "codex:turn/started": case "codex:turn/completed": this.turn(t); return true;
      case "claude-hook:StopFailure":
        this.turn(t);
        this.error = { at: t, text: whole(String(e.text || e.details || `API error: ${e.error ?? "unknown"}`)) };
        return true;
      case "claude-hook:PreCompact": this.compact = { at: t }; return true;
      case "claude-hook:PostCompact": if (this.compact && this.compact.at <= t) this.compact = null; return true;
      // Whole lines of the reply by their index (a long one comes only at the end, with final).
      case "claude-hook:MessageDisplay": return this.stream(String(e.msg), t, e.i, String(e.delta ?? ""));
      case "claude-hook:PermissionDenied":
        if (!e.id) return false;
        this.denied.set(String(e.id), String(e.reason ?? ""));
        if (this.denied.size > 200) this.denied.delete(this.denied.keys().next().value);
        return true;
      // Anything Codex does next: it got past a reconnect.
      case "codex:item/started":
        this.retry = null;
        if (e.type === "contextCompaction") this.compact = { at: t };
        else if (e.type === "agentMessage") this.stream(String(e.item), t, 0, "");
        return true;
      case "codex:item/completed":
        this.retry = null;
        if (e.type === "contextCompaction") this.compact = null;
        return true;
      case "codex:item/agentMessage/delta": this.retry = null; return this.stream(String(e.item), t, null, String(e.delta ?? ""));
      case "codex:turn/plan/updated":
        this.plan = { at: t, steps: (Array.isArray(e.plan) ? e.plan : []).map((s) => ({ text: String(s?.step ?? ""), status: STEP[s?.status] ?? "pending" })) };
        return true;
      // A reconnect (the turn goes on); an error that ends the turn is in the log (task_complete).
      case "codex:error": if (!e.retry) return false; this.retry = { at: t, text: retryWords(e.error) }; return true;
    }
    return false;
  }

  // A turn began or ended: what streamed in the last one is done.
  turn(t) {
    if (t < this.turnAt) return;
    this.turnAt = t;
    this.tail = this.retry = this.plan = null;
    if (this.compact && this.compact.at < t) this.compact = null;
  }

  // A piece of the reply streaming in: at index i (Claude Code's lines), else after the rest
  // (Codex's deltas; its item's start is index 0). One whose start was missed (the file read
  // from the middle, or Codex's tap joining late) isn't shown.
  stream(id, t, i, delta) {
    if (t < this.turnAt) return false;
    if (this.tail?.id !== id) {
      if (this.tail && t < this.tail.start) return false;
      this.tail = { id, start: t, parts: [], whole: false };
    }
    if (Number.isInteger(i)) this.tail.parts[i] = delta; else this.tail.parts.push(delta);
    if (i === 0) this.tail.whole = true;
    return true;
  }

  // Compacting, as far as the log doesn't say it's done (its divider after it began).
  compacting(conv, working) {
    return Boolean(working && this.own && this.compact && !((conv?.compactedAt ?? 0) >= this.compact.at - 1000));
  }

  // Is the streaming reply in the log now? Codex's by its message id. Claude Code's lines carry
  // no id the log has: a reply of this turn with the same words so far. (Not by time: with
  // thinking on, Claude Code shows a reply's lines only after the log has it, seconds later.)
  logged(items, text) {
    const t = this.tail, a = norm(text);
    for (let i = items.length - 1; i >= 0 && i >= items.length - 80; i--) {
      const x = items[i];
      if (x.kind !== "agent") continue;
      if (x.mid !== undefined) { if (x.mid === t.id) return true; continue; }
      const b = norm(x.text), n = Math.min(a.length, b.length, 200);
      if (n > 0 && a.slice(0, n) === b.slice(0, n)) return true;
    }
    return false;
  }

  // The conversation's items with what the log doesn't say yet, after its last record. While the
  // agent works: the reply streaming in, a reconnect, Codex's plan as it changes. An API error
  // that ended the turn shows until the log says it, working or not. Steps auto mode refused are
  // marked denied.
  over(conv, working) {
    let items = conv?.items ?? [];
    if (!this.own || !conv) return items;
    // The latest turn: from your last message on (a steer goes on with it).
    let k = items.length;
    while (k > 0 && !(items[k - 1].kind === "user" && !items[k - 1].steer)) k--;
    const since = (items[k - 1]?.at ?? 0) - 2000;
    const turn = items.slice(k);
    const add = [];
    const err = this.error;
    if (err && err.at >= since && !turn.some((x) => x.kind === "error" && !x.retry)) {
      // In place of the log's retry row, as the log's own error would be (Conversation.failed()).
      if (conv.retry && turn.includes(conv.retry)) items = items.map((x) => (x === conv.retry ? { ...x, text: err.text, retry: false } : x));
      else add.push({ kind: "error", id: `le${err.at}`, text: err.text });
    }
    if (this.denied.size) items = items.map((x) => (x.kind === "tools" && x.steps.some((s) => this.denied.has(s.id))
      ? { ...x, steps: x.steps.map((s) => (this.denied.has(s.id) ? { ...s, denied: true } : s)) } : x));
    if (working) {
      const t = this.tail;
      const text = t?.whole && t.start >= since ? streamed(t.parts.join("")) : "";
      // (A turn the log already ended, stopped too, streams no more.)
      if (text && !turn.some((x) => x.kind === "turnend" && (x.at ?? 0) >= t.start) && !this.logged(turn, text)) add.push({ kind: "agent", id: `live:${t.id}`, text, at: t.start, live: true });
      if (this.retry && this.retry.at >= since) add.push({ kind: "error", id: "live:retry", text: this.retry.text, retry: true });
      if (this.plan?.steps.length && this.plan.at >= since) {
        const p = { steps: this.plan.steps, text: this.plan.steps.map((s) => s.text).join("\n") };
        if (conv.plan && turn.includes(conv.plan)) items = items.map((x) => (x === conv.plan ? { ...x, ...p } : x));
        else add.push({ kind: "plan", id: "live:plan", ...p });
      }
    }
    return add.length ? [...items, ...add] : items;
  }
}
