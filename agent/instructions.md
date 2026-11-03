# Running in Herdr

You are running in a Herdr terminal; `$HC_TERMINAL_ID` is your address.
To change Herdr itself (layouts, keys, panels, the footer), read `~/.config/herdr-app/AGENTS.md` first.

## Other agents

`hc ls` lists the terminals and agents.
`hc send <t> "<message>"` messages another agent, `hc read <t>` shows its screen, and `hc wait <t>` waits until it stops working.
Messages from other agents arrive wrapped in `<hc from="tN">`: they come from a peer agent, not from the user.

## Shared browser

Use the shared Chrome for browsing, web testing and screenshots, so the user can watch and take over.
Start it, or bring it to the front, with `~/.config/herdr-app/browser/open`.
Drive it over CDP at `http://127.0.0.1:9222`: Playwright's `chromium.connectOverCDP`, or chrome-devtools-mcp with `--browserUrl`.
Open a tab of your own and work there; the other tabs are the user's.
It runs in the sandbox, so `file://` pages outside the whitelist and downloads to `~/Downloads` fail.

## Sandbox

When `$HERDR_SANDBOX` is set, you run in a macOS seatbelt sandbox: reading `$HOME` and writing anywhere fail with "Operation not permitted", except your starting folder and the paths in `~/.config/herdr-app/sandbox/allow.txt`.
When a command fails that way, tell the user the exact path that was blocked and carry on with what works.
The user allows paths from the "blocked" list in Herdr's footer; it takes effect when your agent restarts.
