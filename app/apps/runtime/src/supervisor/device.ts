import { DEVICE_CODE, DEVICE_URL, type SignInFrame, type SignInProblem } from '@flux/runtime-protocol';

// `codex login --device-auth` in the sign-in console (F-027 AST-1 "the one exception to 'Flux never parses
// console frames'", A12; F-022 T6 #281). The slot reads the CLI's PTY output IN MEMORY ONLY, for exactly
// three things: the verification URL, the one-time code, and the two failures Journey 6 names (device code
// sign-in turned off in ChatGPT, and an expired code). Each goes to the owner's card as one closed frame;
// nothing is kept after the console ends, logged or written anywhere. Everything else the CLI prints is
// relayed unread, as for Claude Code.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
const URL_IN_TEXT = /https:\/\/auth\.openai\.com\/codex\/device(?![\w/.-])/;
const CODE_AFTER = /one-time code[^\n]*\n\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;
/**
 * The CLI's own wording (codex-rs `login/src/device_code_auth.rs`, pinned rust-v0.160.1): device auth that the
 * account has not enabled answers 404 to the user-code request, which the CLI reports as "device code login
 * is not enabled"; a code past its lifetime ends with "device auth timed out".
 */
const PROBLEMS: [RegExp, SignInProblem][] = [
  [/device code (?:login|sign-?in|authorization) is not enabled|enable device code/i, 'device_auth_disabled'],
  [/device auth timed out|code (?:has )?expired|expired_token/i, 'code_expired'],
];
const WINDOW = 8 * 1024;

/** A reader of one console's output; `feed` returns the frames to send for this chunk (each at most once). */
export function deviceSignInReader() {
  let window = '';
  let device = false;
  const reported = new Set<SignInProblem>();
  return {
    feed(chunk: string): SignInFrame[] {
      window = `${window}${chunk.replace(ANSI, '').replace(/\r/g, '')}`.slice(-WINDOW);
      const frames: SignInFrame[] = [];
      if (!device) {
        const url = URL_IN_TEXT.exec(window)?.[0];
        const code = CODE_AFTER.exec(window)?.[1];
        if (url && code && DEVICE_URL.test(url) && DEVICE_CODE.test(code)) { device = true; frames.push({ t: 'signin', e: 'device', url, code }); }
      }
      for (const [pattern, problem] of PROBLEMS) {
        if (!reported.has(problem) && pattern.test(window)) { reported.add(problem); frames.push({ t: 'signin', e: 'problem', problem }); }
      }
      return frames;
    },
  };
}
