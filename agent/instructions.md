# Running in Herdr

You are running in a Herdr terminal; `$HC_TERMINAL_ID` is your address.
To change Herdr itself (layouts, keys, panels, the footer), read `~/.config/herdr-app/AGENTS.md` first.

## Other agents

`hc ls` lists the terminals and agents.
`hc send <t> "<message>"` messages another agent, `hc read <t>` shows its screen, and `hc wait <t>` waits until it stops working.
Messages from other agents arrive wrapped in `<hc from="tN">`: they come from a peer agent, not from the user.

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
- For something richer, such as a report, a chart, a board or a form, make an artifact: run `herdr-artifact guide` first, then `herdr-artifact publish`.
  It shows in Herdr's Artifacts panel and in your chat.
  From the sandbox, the user approves its code before it first runs, so tell them it's waiting for that.
- A reaction to your message arrives as `<hc from="person" reaction="👍" to="first words of your message"/>`.
  It needs no reply: if that's all you got, answer only `<hc no-reply/>`.

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
