# herdr-config

My [Herdr](https://herdr.dev) app setup: sandboxed agents, per-repo worktree setup and teardown, space folders, and a context and usage footer.
macOS only, because the sandbox uses `sandbox-exec`.

## Install

```sh
git clone https://github.com/karrui/herdr-config.git
./herdr-config/install.sh
```

Start the Herdr app once before you run this.
The script copies everything into `~/.config/herdr-app`.
It keeps any file it replaces as `<file>~`.
Then press `cmd-shift-l` until the window shows the **main-sandbox** layout.

You need `jq`, `claude` and/or `codex`, and Google Chrome if you want the shared browser.

### Context and usage in the footer

The footer shows context, 5h and weekly usage for the focused agent.
For Claude Code, the footer needs the status line payload, so add this line to your status line script (`statusLine.command` in `~/.claude/settings.json`):

```sh
printf '%s' "$input" | ~/.config/herdr-app/usage/claude-statusline
```

Here `$input` is the JSON your script reads from stdin.
If you have no status line yet, point `statusLine.command` at `~/.config/herdr-app/usage/claude-statusline` directly.
It prints nothing, so Claude Code's own status line stays empty.
Codex needs no setup: `usage/codex-usage` reads Codex's session files.

## What's in it

| Path | What it does |
|---|---|
| `agent/launch` | Starts `claude` / `codex` with `agent/instructions.md` appended, optionally sandboxed. `programs.json` points the + menu at it. |
| `sandbox/agent-sandbox` | Seatbelt sandbox: blocks reading `$HOME` and writing anywhere, except the starting folder (and its worktree's `.git`) and `allow.txt`. `deny.txt` always wins. Strips `SSH_AUTH_SOCK` and `AWS_*`. |
| `sandbox/allow.txt`, `deny.txt` | The sandbox lists. Edit them here or from the footer's settings icon (`sandbox-lists` mod). |
| `sandbox/logger` | Logs blocked accesses to `sandbox/blocked/`, which the footer shows as "N blocked". You can allow paths from there. |
| `sandbox/agent-restart` | Restarts a Claude/Codex agent in place and resumes its conversation. |
| `agent/worktree` | Worktree setup and teardown, from `worktrees/<repo>.yaml`: copies files in, runs setup in a Setup pane before the agent starts, and runs teardown on Remove worktree. |
| `worktrees/idp.yaml` | Example for `~/Projects/idp`. Change `repo:` if your checkout lives elsewhere. |
| `usage/` | Feeds for the footer's context and usage numbers. |
| `browser/open` | A shared sandboxed Chrome that agents drive over CDP on port 9222. |
| `layouts/main-sandbox.json` | The layout that ties the mods together. |
| `keys.json` | Key bindings. `cmd-alt-[` / `]` move between space folders in this layout. |
| `mods/` | `agent-bar` (footer: usage + sandbox), `space-folders` (sidebar folders, new worktree spaces), `worktree-hooks` / `worktree-setup` / `resources` (worktree setup UI and its containers), `menu-hooks` (right-click menus), `tabs-sandbox`, `agents-sandbox`, `new-menu-sandbox`, `status-sandbox`, `sandbox-lists`. |

## Restarting an agent

Changes to the sandbox lists only apply when an agent starts.
To pick them up, right-click the agent's tab and choose **Restart agent**.
The agent restarts in the same sandbox mode and resumes its conversation.
To turn the sandbox on or off for an agent, click "Sandbox: ..." in the footer.

## Updating

Pull, then run `./install.sh` again.
Edits you made in `~/.config/herdr-app` get overwritten, but each one is kept as `<file>~`.
