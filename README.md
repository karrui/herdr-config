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
| `mods/` | `agent-bar` (footer: usage + sandbox), `space-folders` (sidebar folders, new worktree spaces), `worktree-hooks` / `worktree-setup` / `resources` (worktree setup UI and its containers), `menu-hooks` (right-click menus), `changes-sandbox` (Changes panel with modes, below), `linear` (the branch's Linear ticket, below), `tabs-sandbox`, `agents-sandbox`, `new-menu-sandbox`, `status-sandbox`, `sandbox-lists`. |

## Changes panel

The dropdown at the top of the Changes panel picks what it compares, like Codex's:

- **Last Turn**: what the focused agent changed since it last started working.
- **Uncommitted**, **Unstaged**, **Staged**: the working tree against `HEAD`, the index, or `HEAD` from the index.
- **Committed**: one commit, picked from this branch's commits (or the latest 30).
- **Branch**: everything on this branch since it left `origin/main` (origin's default branch), uncommitted work included.

Last Turn snapshots the repo when an agent starts working, while the panel is running.
A turn that started before the panel was first opened, or before Herdr restarted, has no snapshot.
In Staged, Commit commits only what's staged; everywhere else it commits everything.
The Changes button in the tab bar shows the branch's lines added and removed against the same base, tracked files only.

## Linear panel

The **Linear** button in the tab bar opens the ticket for the focused pane's branch.
The button shows the ticket's id once it finds one, and just the icon otherwise.
It finds the ticket in this order:

1. A ticket you linked to this branch by hand, with the panel's Link field (an id like `DEVX-684` or a Linear URL).
2. A ticket id in the branch name, such as `karrui/devx-684-fix`, if `DEVX` is one of your workspace's teams.
3. The issue Linear itself ties to the branch name.

Right-click the Linear button to link a different ticket, say "Not this ticket" (stops detecting one for that branch), go back with "Detect from branch", open the ticket, or change the API key.
With no ticket, the panel itself has a field to link one.
Links are per repo and branch.
`mods/tabs-sandbox/linear-resolve.js` is a copy of `mods/linear/resolve.js`, because mods can't import each other: change both.

The first time, the panel asks for a Linear personal API key (later, change it from the right-click menu), which you create in Linear's Security & access settings.
It's saved to `~/.config/herdr-app/data/linear/api-key` (mode 600), which sandboxed agents can't read, and never goes in this repo.

## Restarting an agent

Changes to the sandbox lists only apply when an agent starts.
To pick them up, right-click the agent's tab and choose **Restart agent**.
The agent restarts in the same sandbox mode and resumes its conversation.
To turn the sandbox on or off for an agent, click "Sandbox: ..." in the footer.

## Updating

Pull, then run `./install.sh` again.
Edits you made in `~/.config/herdr-app` get overwritten, but each one is kept as `<file>~`.
