// Shared by space-folders, worktree-hooks, worktree-setup, resources and tabs-sandbox.
import { appHome } from "herdr";
import { loginExec } from "./shell.js";

export function worktreeArgv(action, folder, args = [], on = null) {
  const command = on ? ["sh", "-c", 'exec "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/agent/worktree" "$@"', "worktree"]
    : [`${appHome()}/agent/worktree`];
  return [...command, action, folder, ...args];
}

export function worktreeExec(action, folder, args = [], on = null) {
  const [command, ...argv] = worktreeArgv(action, folder, args, on);
  return loginExec(command, argv, { on });
}
