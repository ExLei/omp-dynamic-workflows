/**
 * Hand a URL to the desktop's default browser.
 *
 * omp's own `openInBrowser` lives on the interactive-mode context and is not
 * reachable from `ExtensionUIContext`, so the console opens the URL itself.
 * `execFile` (never a shell) keeps the token in the URL out of shell parsing:
 * on Windows `cmd /c start` would eat `&` and mangle the query string.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** True when a browser can plausibly be reached from this process. */
export function canOpenBrowser(env: Record<string, string | undefined> = process.env): boolean {
  if (process.platform === "win32" || process.platform === "darwin") return true;
  // A headless box or an SSH session has nothing to show; the caller should
  // print the URL instead of silently doing nothing.
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

function opener(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "win32":
      // Passes the URL as one argv entry — no shell, no `&`/`?` quoting hazard.
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    case "darwin":
      return { command: "open", args: [url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/**
 * Open `url` in the default browser. Resolves to the failure reason instead of
 * throwing: not being able to open a browser must never break the command that
 * already printed the URL.
 */
export async function openInBrowser(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!canOpenBrowser()) return { ok: false, reason: "no desktop session (headless or SSH)" };
  const { command, args } = opener(url);
  try {
    await exec(command, args);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
