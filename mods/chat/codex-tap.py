#!/usr/bin/env python3
# A second client on a Codex TUI's private app-server (agent/codex-live starts both). It joins
# the TUI's threads and writes the chat's live events (the contract is in event-hook.sh), and
# puts Codex's approvals and questions in chat-asks as ask-hook.sh does, in Claude's words
# (tool_name, tool_input) so the chat's cards show them. It answers the server only with what
# the person picked on a card; the TUI shows every prompt too, and whichever answers first wins.
# usage: codex-tap.py <socket> <dir> <terminal> <server pid>
#   <dir>: the folder holding chat-events/ and chat-asks/ (the sandbox spool, else data/).
import base64, json, os, select, shlex, signal, socket, struct, sys, time

SOCK, DIR, TERM, SERVER = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
EVENTS = f"{DIR}/chat-events/{TERM}.jsonl"
ASKS = f"{DIR}/chat-asks"
PARENT = os.getppid()
# asks.js deny()'s words when the person only pressed Deny.
DENIED = "The person declined this in the chat."


def clip(s, n):
    if not isinstance(s, str):
        return s
    return s if len(s) <= n else s[: n - 1] + "…"


def shown(cmd):
    """A command as the TUI shows it: without the `/bin/zsh -lc '...'` Codex runs it in."""
    try:
        argv = shlex.split(cmd or "")
    except ValueError:
        return cmd
    return argv[2] if len(argv) == 3 and argv[0].endswith("sh") and argv[1] in ("-c", "-lc") else cmd


def emit(ev, **fields):
    line = {"t": int(time.time() * 1000), "src": "codex", "ev": ev}
    line.update((k, v) for k, v in fields.items() if v is not None)
    data = (json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    if len(data) > 16384:
        data = (json.dumps({k: line[k] for k in ("t", "src", "ev")} | {"thread": line.get("thread"), "cut": True}) + "\n").encode()
    try:
        # Nobody reading (no chat open): keep it bounded.
        if os.path.getsize(EVENTS) > 1 << 20:
            open(EVENTS, "w").close()
    except OSError:
        pass
    try:
        # Opened per line: the chat may empty or replace the file at any time.
        fd = os.open(EVENTS, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
    except OSError:
        pass


def put(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


def rm(*paths):
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass


class Conn:
    """A WebSocket client over the server's Unix socket: just what the app-server needs."""

    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.connect(path)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(f"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            c = self.s.recv(4096)
            if not c:
                raise EOFError
            buf += c
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise EOFError
        self.msg = b""

    def frame(self, op, data):
        mask, n = os.urandom(4), len(data)
        size = bytes([0x80 | n]) if n < 126 else bytes([0xFE]) + struct.pack(">H", n) if n < 65536 else bytes([0xFF]) + struct.pack(">Q", n)
        self.s.sendall(bytes([0x80 | op]) + size + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def send(self, obj):
        self.frame(1, json.dumps(obj).encode())

    def read(self):
        """The whole messages that have come in (server frames are never masked)."""
        c = self.s.recv(1 << 16)
        if not c:
            raise EOFError
        self.buf += c
        out = []
        while len(self.buf) >= 2:
            b = self.buf
            n, at = b[1] & 0x7F, 2
            if n == 126:
                if len(b) < 4:
                    break
                n, at = struct.unpack(">H", b[2:4])[0], 4
            elif n == 127:
                if len(b) < 10:
                    break
                n, at = struct.unpack(">Q", b[2:10])[0], 10
            if len(b) < at + n:
                break
            payload, self.buf, op = b[at:at + n], b[at + n:], b[0] & 0x0F
            if op == 8:
                raise EOFError
            if op == 9:
                self.frame(0xA, payload)
            if op not in (0, 1, 2):
                continue
            self.msg += payload
            if b[0] & 0x80:
                try:
                    out.append(json.loads(self.msg))
                except ValueError:
                    pass
                self.msg = b""
        return out


conn = None
calls = {}      # our request id -> fn(result, error)
joined = {}     # thread id -> its folder
joining = set()
changes = {}    # fileChange item id -> its changes, for the approval card
pending = {}    # ask id -> (server request id, method, params)
seq = asked = 0
reply = None
held = None     # the TUI's rollout, kept open    # agent message deltas not written yet: [item, thread, turn, text, since]


def call(method, params, then=None):
    global seq
    seq += 1
    calls[seq] = then
    conn.send({"id": seq, "method": method, "params": params})


# ---- threads -------------------------------------------------------------------------------

def join(tid):
    """Joins a thread the TUI has loaded. A new one can't be joined until its first turn writes
    the rollout: the next status change or poll tries again."""
    if not tid or tid in joined or tid in joining:
        return
    joining.add(tid)

    def done(r, _e):
        global held
        joining.discard(tid)
        if not r:
            return
        th = r.get("thread") or {}
        joined[tid] = r.get("cwd") or th.get("cwd")
        emit("joined", thread=tid, rollout=th.get("path"), cwd=joined[tid])
        # The chat, the footer and agent-restart find Codex's rollout as the file a process under
        # the terminal holds open. The TUI held it; the server doesn't until it next writes (a
        # resumed thread sits unfound until its first turn), so the tap holds the TUI's own
        # thread's (not a subagent's).
        if th.get("path") and not th.get("parentThreadId"):
            try:
                f = open(th["path"], "rb")
            except OSError:
                return
            if held:
                held.close()
            held = f

    call("thread/resume", {"threadId": tid, "excludeTurns": True}, done)


def poll():
    call("thread/loaded/list", {}, lambda r, _e: [join(t) for t in (r or {}).get("data") or []])


# ---- events --------------------------------------------------------------------------------

def item(it):
    ty, f = it.get("type"), {"item": it.get("id"), "type": it.get("type"), "status": it.get("status")}
    if ty == "commandExecution":
        f.update(command=clip(shown(it.get("command")), 300), exit=it.get("exitCode"))
    elif ty == "fileChange":
        f.update(files=[c.get("path") for c in it.get("changes") or []][:20])
    elif ty in ("mcpToolCall", "dynamicToolCall", "collabAgentToolCall"):
        f.update(server=it.get("server"), tool=it.get("tool"))
    elif ty == "webSearch":
        f.update(query=clip(it.get("query"), 300))
    return f


def flush():
    global reply
    if reply:
        emit("item/agentMessage/delta", thread=reply[1], turn=reply[2], item=reply[0], delta=reply[3])
        reply = None


def text_of(sub):
    return clip(" ".join(i.get("text", "") for i in sub.get("input") or [] if i.get("type") == "text"), 300)


def note(method, p):
    global reply
    tid = p.get("threadId")
    if method == "item/agentMessage/delta":
        # Coalesced: a reply streams in many small pieces.
        if reply and reply[0] != p.get("itemId"):
            flush()
        reply = reply or [p.get("itemId"), tid, p.get("turnId"), "", time.time()]
        reply[3] += p.get("delta") or ""
        if len(reply[3]) >= 2000:
            flush()
        return
    flush()
    at = {"thread": tid, "turn": p.get("turnId")}
    if method == "thread/status/changed":
        st = p.get("status") or {}
        join(tid)
        emit(method, **at, status=st.get("type"), flags=st.get("activeFlags") or None)
    elif method in ("turn/started", "turn/completed"):
        turn = p.get("turn") or {}
        done = method == "turn/completed"
        emit(method, thread=tid, turn=turn.get("id"), status=turn.get("status") if done else None,
             error=clip((turn.get("error") or {}).get("message"), 500))
    elif method in ("item/started", "item/completed"):
        it = p.get("item") or {}
        if it.get("type") == "fileChange":
            if method == "item/started":
                changes[it.get("id")] = it.get("changes") or []
            else:
                changes.pop(it.get("id"), None)
        emit(method, **at, **item(it))
    elif method == "item/fileChange/patchUpdated":
        changes[p.get("itemId")] = p.get("changes") or []
    elif method == "turn/plan/updated":
        emit(method, **at, explanation=clip(p.get("explanation"), 500),
             plan=[{"step": clip(s.get("step"), 200), "status": s.get("status")} for s in (p.get("plan") or [])[:50]])
    elif method == "error":
        e = p.get("error") or {}
        info = e.get("codexErrorInfo")
        emit(method, **at, error=clip(e.get("message"), 500), retry=p.get("willRetry"),
             info=info if not isinstance(info, dict) else next(iter(info), None))
    elif method == "thread/queue/changed":
        call("thread/queue/list", {"threadId": tid},
             lambda r, _e: emit(method, thread=tid, queue=None if r is None else [text_of(s) for s in r.get("data") or []]))
    elif method == "serverRequest/resolved":
        for aid, (rid, _m, _p) in list(pending.items()):
            if rid == p.get("requestId"):
                # Answered in the TUI (or by its auto-review): the card goes, saying so (said
                # first: the chat reads why once the request is gone).
                del pending[aid]
                put(f"{ASKS}/end/{aid}", "Answered in the terminal\n")
                rm(f"{ASKS}/req/{aid}.json")
    elif method == "thread/closed":
        joined.pop(tid, None)
        emit(method, thread=tid)


# ---- approvals and questions ---------------------------------------------------------------

def words(method, p):
    """The request in Claude's words, for asks.js; None leaves it to the TUI alone."""
    cwd = joined.get(p.get("threadId"))
    if method == "item/commandExecution/requestApproval":
        return {"tool_name": "Bash", "cwd": p.get("cwd") or cwd,
                "tool_input": {"command": shown(p.get("command")) or p.get("reason") or "a command", "description": p.get("reason")}}
    if method == "item/fileChange/requestApproval":
        return {"tool_name": "apply_patch", "cwd": cwd, "tool_input": {"reason": p.get("reason"), "files": [
            {"path": c.get("path"), "kind": (c.get("kind") or {}).get("type"), "diff": c.get("diff")} for c in changes.get(p.get("itemId")) or []]}}
    if method == "item/permissions/requestApproval":
        return {"tool_name": "request_permissions", "cwd": p.get("cwd") or cwd,
                "tool_input": {"reason": p.get("reason"), "permissions": p.get("permissions")}}
    if method == "item/tool/requestUserInput":
        qs = p.get("questions") or []
        # A secret (a password) isn't typed into the chat.
        if not qs or any(q.get("isSecret") for q in qs):
            return None
        return {"tool_name": "AskUserQuestion", "cwd": cwd, "tool_input": {"questions": [
            {"question": q.get("question"), "header": q.get("header"), "multiSelect": False,
             "options": [{"label": o.get("label"), "description": o.get("description")} for o in q.get("options") or []]}
            for q in qs]}}
    return None


def ask(m):
    req = words(m.get("method"), m.get("params") or {})
    if req is None:
        return
    global asked
    asked += 1
    # <terminal>.<n>.<time>.<pid>: the chat reads the time and drops asks whose pid is gone.
    aid = f"{TERM}.{asked}.{int(time.time())}.{os.getpid()}"
    try:
        put(f"{ASKS}/req/{aid}.json", json.dumps(req))
    except OSError:
        return
    pending[aid] = (m["id"], m["method"], m.get("params") or {})


def answer(aid, d):
    """The chat's answer: a PermissionRequest hook decision (asks.js), or None for none (the
    person answers in the terminal)."""
    rid, method, p = pending.pop(aid)
    rm(f"{ASKS}/req/{aid}.json", f"{ASKS}/ans/{aid}.json")
    if not isinstance(d, dict):
        return
    allow, msg = d.get("behavior") == "allow", d.get("message")
    if method == "item/tool/requestUserInput":
        given = (d.get("updatedInput") or {}).get("answers") or {}
        res = {"answers": {q.get("id"): {"answers": [a for a in [str(given.get(q.get("question")) or "") if allow else msg] if a]}
                           for q in p.get("questions") or []}}
    elif method == "item/permissions/requestApproval":
        res = {"permissions": p.get("permissions") or {}, "scope": "turn"} if allow else {"permissions": {}}
    else:
        res = {"decision": "accept" if allow else "decline"}
    conn.send({"id": rid, "result": res})
    # Words written in the chat instead of a press (cards.js replyWith): Codex's decline carries
    # no message, so they go to the agent as part of its turn.
    if not allow and msg and msg != DENIED and method != "item/tool/requestUserInput":
        call("turn/steer", {"threadId": p.get("threadId"), "expectedTurnId": p.get("turnId"),
                            "input": [{"type": "text", "text": msg, "text_elements": []}]})


def answers():
    for aid in list(pending):
        path = f"{ASKS}/ans/{aid}.json"
        try:
            text = open(path).read()
            age = time.time() - os.path.getmtime(path)
        except OSError:
            continue
        try:
            d = json.loads(text)["hookSpecificOutput"]["decision"]
        except (ValueError, KeyError, TypeError):
            # Empty is no answer (the chat closed, or "Answer in terminal"), but so does a
            # file caught half written look: give the writer a moment.
            if age < 1:
                continue
            d = None
        answer(aid, d)


# ---- main ----------------------------------------------------------------------------------

def handle(m):
    if "method" in m and "id" in m:
        ask(m)
    elif "id" in m:
        fn = calls.pop(m["id"], None)
        if fn:
            fn(m.get("result"), m.get("error"))
    elif "method" in m:
        note(m["method"], m.get("params") or {})


def main():
    global conn
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
    for sub in ("req", "ans", "end"):
        os.makedirs(f"{ASKS}/{sub}", exist_ok=True)
    conn = Conn(SOCK)
    call("initialize", {"clientInfo": {"name": "herdr-tap", "version": "1"}, "capabilities": {"experimentalApi": True}},
         lambda _r, _e: (conn.send({"method": "initialized"}), poll()))
    polled = time.time()
    try:
        while True:
            if select.select([conn.s], [], [], 0.1)[0]:
                for m in conn.read():
                    try:
                        handle(m)
                    except Exception as e:  # one odd message never stops the tap
                        print(f"codex-tap: {e!r}", file=sys.stderr)
            if reply and time.time() - reply[4] >= 0.1:
                flush()
            answers()
            if time.time() - polled >= 2:
                polled = time.time()
                poll()
            # codex-live was killed before it could stop the server: stop it from here.
            if os.getppid() != PARENT:
                os.kill(SERVER, signal.SIGTERM)
                return
    except (EOFError, OSError):
        pass
    finally:
        flush()
        for aid in pending:
            try:
                put(f"{ASKS}/end/{aid}", "Agent stopped\n")
            except OSError:
                pass
            rm(f"{ASKS}/req/{aid}.json", f"{ASKS}/ans/{aid}.json")


if __name__ == "__main__":
    main()
