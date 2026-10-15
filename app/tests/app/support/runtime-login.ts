// The line a person pastes at `claude auth login`'s prompt (Claude Code's code#state rule, F-022 T4): the
// code with the `state` the CLI printed in its authorize URL, taken from the terminal output so far.
export const pastedLine = (output: string, code: string) => `${code}#${/state=([A-Za-z0-9_-]+)/.exec(output)?.[1] ?? 'no-state-was-printed'}\r`;
