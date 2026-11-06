// Shared by space-folders, worktree-hooks, worktree-setup, resources and tabs-sandbox.
import { exec } from "herdr";

// Keep arguments separate while loading the target user's shell environment and auth.
export function loginArgv(command, args) {
  return ["sh", "-c", 'case "${SHELL:-/bin/sh}" in */fish) exec "$SHELL" -lic \'cd "$argv[1]"; or exit; exec $argv[2..]\' -- "$PWD" "$@" ;; *) exec "${SHELL:-/bin/sh}" -lic \'cd "$1" && shift && exec "$@"\' sh "$PWD" "$@" ;; esac', "sh", command, ...args];
}

export function loginExec(command, args, options) {
  const [program, ...argv] = loginArgv(command, args);
  return exec(program, argv, options);
}
