/**
 * QR code rendering for the sign-in URL.
 *
 * The dialog shows the gateway's `authUrl` as a scannable code without sending
 * that URL — a one-time sign-in token — to any third-party image service, so the
 * SVG is built locally from `qrcode-generator` (MIT) and served by the plugin's
 * own loopback route.
 *
 * @module dsh-workbuddy-pool/qr
 */

import { qrcode } from "./vendor/qrcode.mjs";

/** Guard against a pathological query value being rasterized into a huge SVG. */
const MAX_TEXT_BYTES = 1024;

/**
 * Render one string as an inline SVG QR code.
 *
 * Error correction level M is the usual trade-off for a URL on a phone screen;
 * version 0 lets the library pick the smallest version that fits.
 *
 * @param text - the payload (the gateway sign-in URL).
 * @param options - optional cell size and quiet-zone margin, in pixels.
 * @returns a standalone `<svg>` document.
 */
export function qrSvg(text, options = {}) {
  const value = typeof text === "string" ? text : "";
  if (value === "") throw new Error("qr: text is required");
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) throw new Error("qr: text is too long");
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({
    cellSize: options.cellSize ?? 6,
    margin: options.margin ?? 4,
    scalable: true,
  });
}

/** Sign-in hosts the QR route is willing to encode. */
const ALLOWED_HOSTS = new Set(["codebuddy.cn", "www.codebuddy.cn", "codebuddy.ai", "www.codebuddy.ai", "workbuddy.ai", "www.workbuddy.ai", "workbuddy.cc", "www.workbuddy.cc"]);

/** Whether `value` is an https sign-in URL on one of the gateway hosts. */
export function isSignInUrl(value) {
  if (typeof value !== "string" || value === "") return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}
