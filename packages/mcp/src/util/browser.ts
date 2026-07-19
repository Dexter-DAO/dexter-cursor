/**
 * Shared browser + terminal helpers for the "print a link, approve on any
 * device" CLI flows (`opendexter connect`, `opendexter dextercard login`).
 *
 * Both helpers are deliberately best-effort and non-throwing: the flows that
 * use them are browser-OPTIONAL by design (they also print the raw URL, a
 * terminal QR, and a hand-typable code), so a headless box with no browser and
 * no display must degrade quietly, never crash the ceremony.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
// qrcode-terminal is CommonJS: under real Node ESM its `.generate` lives on the
// default export (a namespace `import *` leaves `.generate` undefined), so we
// take the default. esModuleInterop makes this the module.exports object under
// both real ESM and the esbuild-based build/test path.
import qrcodeTerminal from "qrcode-terminal";

/**
 * Best-effort: open a URL in the user's default browser. Returns whether the
 * spawn was issued (not whether a browser actually appeared — we can't know).
 * Falls back to `false` on any platform we can't drive, so callers keep the
 * printed link + QR as the real path.
 */
export function tryOpenInBrowser(url: string): boolean {
  const cmd =
    platform() === "darwin" ? "open" :
    platform() === "win32" ? "start" :
    "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Render a scannable QR code for `url` as a block of terminal text. Uses
 * qrcode-terminal (never hand-rolled): its `generate` invokes the callback
 * synchronously with the rendered string, so we can return it directly.
 * `small: true` uses half-height blocks so the code fits an 80-col terminal.
 * Returns "" if rendering throws — the caller still has the raw link + code.
 */
export function renderQr(url: string): string {
  try {
    let out = "";
    qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
      out = qr;
    });
    return out;
  } catch {
    return "";
  }
}
