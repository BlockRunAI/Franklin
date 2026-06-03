/**
 * Pure heuristics for the bracketed-paste handler in app.tsx, split out so they
 * can be unit-tested without pulling in Ink/React.
 */

// Image filenames a terminal might substitute for a pasted image. Anchored, so
// only a string that *is* such a path matches — not prose that mentions one.
const IMAGE_FILE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i;

/**
 * Does a bracketed-paste buffer look like a terminal's stand-in for an image
 * paste rather than genuine pasted text?
 *
 * Cmd+V on a clipboard image yields an *empty* buffer on macOS Terminal/iTerm2,
 * but several Linux terminals instead emit a filename, a `file://` URI, or the
 * raw image header alongside the paste. Those shapes — and only those — warrant
 * the (async, 30-100 ms) clipboard probe in app.tsx. Substantial text returns
 * `false` so it can be inserted synchronously, keeping the common paste path
 * instant instead of waiting on an osascript / xclip / wl-paste shell-out.
 *
 * False positives are harmless: a literal text paste of "photo.png" probes the
 * clipboard, finds no image, and falls through to the text path anyway.
 */
export function looksLikeImagePasteStub(buffered: string): boolean {
  // macOS image paste: empty / whitespace-only bracketed paste.
  if (buffered.trim().length === 0) return true;

  // Raw binary the terminal dumped (e.g. PNG's \x1a, or bytes that failed
  // UTF-8 decoding into U+FFFD). Genuine text never carries control chars
  // other than tab / newline / carriage return.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f�]/.test(buffered)) return true;

  // A single-line file reference the terminal sent instead of the image bytes.
  const trimmed = buffered.trim();
  if (!trimmed.includes('\n')) {
    if (/^file:\/\//i.test(trimmed)) return true; // file:// URI
    if (IMAGE_FILE_EXT.test(trimmed)) return true; // bare filename / path
  }

  return false;
}
