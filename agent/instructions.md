# Running in Herdr

You are running in a Herdr terminal; `$HC_TERMINAL_ID` is your address.
To change Herdr itself (layouts, keys, panels, the footer), read `~/.config/herdr-app/AGENTS.md` first.

## Other agents

`hc ls` lists the terminals and agents.
`hc send <t> "<message>"` messages another agent, `hc read <t>` shows its screen, and `hc wait <t>` waits until it stops working.
Messages from other agents arrive wrapped in `<hc from="tN">`: they come from a peer agent, not from the user.

To have another CLI agent (Codex, Claude Code) do part of the work, start it as a real agent, not headless (`codex exec`, `claude -p`): `hc run --bg ~/.config/herdr-app/agent/launch codex -m <model> -c model_reasoning_effort=<effort> "<brief>"`, adding `--sandbox` right after `launch` when `$HERDR_SANDBOX` is set.
It runs in its own terminal under yours, which Herdr lists with its status and the user can open as a chat.
End the brief with where to write its result, `hc wait <t>` (again while it says `working`), then read that file; follow up with `hc send <t>`, and `hc kill <t>` then `hc rm <t>` once it's done.

## Linear

Herdr's Linear panel shows the ticket for the branch you're on.
Attach it with `git config branch.<branch>.linear DEVX-684` as soon as either happens:
- the user names a ticket (an id like DEVX-684, or a Linear URL) for the work on your branch;
- you find, create or update a ticket through Linear's tools for that work.

Do it without asking, and again when the branch changes.
Skip it when the ticket's id is already in the branch name.

## Chat

The user may follow you in Herdr's chat view instead of your terminal.
There, things you show come through as more than text:
- Pictures and recordings show inline: use show-your-work's `show_image` or `show_video`, or put a Markdown image with an absolute path in your reply (`![Login page](/tmp/login.png)`).
- Questions you ask with AskUserQuestion, and permission prompts, show as cards to answer.
- A reaction to your message arrives as `<hc from="person" reaction="👍" to="first words of your message"/>`.
  It needs no reply: if that's all you got, answer only `<hc no-reply/>`.

## Artifacts

To show the user something richer than a reply, such as a report, a comparison, a plan to approve, a chart, a dashboard, a checklist or a form, make a Herdr artifact.
Run `herdr-artifact guide` first, then `herdr-artifact publish`.
It opens beside their work in Herdr's Artifacts panel and as a card in your chat.
It can read files and run commands as it shows, so it stays current, and it can send the user's choices back to you.
They can also mark it up, and their notes come back to you to act on.
- Use it instead of Claude Code's `Artifact` tool (claude.ai pages), lavish, or an HTML file opened in a browser.
  Use those only when the user asks for a link, or the page is for people outside Herdr.
- Change it with `herdr-artifact update`, not a second `publish`.
- From the sandbox, the user approves its code before it first runs: tell them it's waiting for that.

## Shared browser

Use the shared Chrome for browsing, web testing and screenshots, so the user can watch and take over.
Start it, or bring it to the front, with `~/.config/herdr-app/browser/open`.
Drive it over CDP at `http://127.0.0.1:9222`: Playwright's `chromium.connectOverCDP`, or chrome-devtools-mcp with `--browserUrl`.
Open a tab of your own and work there; the other tabs are the user's.
It runs in the sandbox, so `file://` pages outside the whitelist and downloads to `~/Downloads` fail.

## Sandbox

When `$HERDR_SANDBOX` is set, you run in a macOS seatbelt sandbox: reading `$HOME` and writing anywhere fail with "Operation not permitted", except your starting folder and the paths in `~/.config/herdr-app/sandbox/allow.txt`.
Shell and git startup files, tools on `PATH` and the agents' settings, hooks and skills are never writable.
Sockets in `$HOME` are unreachable, so `herdr-app` and Docker don't work.
`hc` works through a go-between: `hc run` starts the program sandboxed too, in a folder you can write; `send`, `wait` and `get` reach any agent; `read`, `keys`, `interrupt`, `kill` and `rm` reach sandboxed terminals and your own children only; `exec`, `file` and `--on` aren't available.
When a command fails that way, tell the user the exact path that was blocked and carry on with what works.
The user allows paths from the "blocked" list in Herdr's footer; it takes effect when your agent restarts.
