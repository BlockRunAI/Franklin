/**
 * Mouse event support for Ink terminal UI.
 * Enables SGR extended mouse tracking (DECSET 1000+1006) and parses events from stdin.
 * Lightweight — only handles clicks, not drag/hover/selection.
 */

import { EventEmitter } from 'node:events';

// ─── Terminal escape sequences ────────────────────────────────────────────

const ENABLE_MOUSE =
  '\x1b[?1000h' + // Normal mouse tracking (clicks + wheel)
  '\x1b[?1006h';  // SGR extended format (readable coordinates)

const DISABLE_MOUSE =
  '\x1b[?1006l' +
  '\x1b[?1000l';

// SGR mouse event format: ESC [ < button ; col ; row M (press) or m (release)
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// ─── Types ────────────────────────────────────────────────────────────────

export interface MouseEvent {
  button: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down';
  action: 'press' | 'release';
  col: number; // 0-indexed
  row: number; // 0-indexed
}

// ─── Mouse Manager ───────────────────────────────────────────────────────

class MouseManager extends EventEmitter {
  private enabled = false;
  private stdinListener: ((data: Buffer) => void) | null = null;

  /**
   * Enable mouse tracking. Call once on app startup.
   * Returns cleanup function to call on unmount.
   */
  enable(): () => void {
    if (this.enabled) return () => {};
    this.enabled = true;

    // Write enable sequences
    process.stdout.write(ENABLE_MOUSE);

    // Listen on stdin for mouse sequences
    // We use 'data' event at a higher priority than Ink's handler.
    // Mouse sequences that we parse are still passed to Ink (we can't consume them),
    // but Ink will ignore unrecognized escape sequences.
    this.stdinListener = (data: Buffer) => {
      const str = data.toString('utf-8');
      let match;
      SGR_MOUSE_RE.lastIndex = 0;
      while ((match = SGR_MOUSE_RE.exec(str)) !== null) {
        const btnCode = parseInt(match[1], 10);
        const col = parseInt(match[2], 10) - 1; // 1-indexed → 0-indexed
        const row = parseInt(match[3], 10) - 1;
        const isPress = match[4] === 'M';

        // Decode button
        const baseBtn = btnCode & 0x03;
        const isWheel = (btnCode & 0x40) !== 0;

        let button: MouseEvent['button'];
        if (isWheel) {
          button = baseBtn === 0 ? 'wheel-up' : 'wheel-down';
        } else {
          button = baseBtn === 0 ? 'left' : baseBtn === 1 ? 'middle' : 'right';
        }

        const event: MouseEvent = {
          button,
          action: isPress ? 'press' : 'release',
          col,
          row,
        };

        this.emit('mouse', event);

        // Emit convenience events
        if (button === 'left' && isPress) {
          this.emit('click', event);
        }
      }
    };

    process.stdin.on('data', this.stdinListener);

    return () => this.disable();
  }

  /**
   * Disable mouse tracking and clean up.
   */
  disable() {
    if (!this.enabled) return;
    this.enabled = false;

    if (this.stdinListener) {
      process.stdin.removeListener('data', this.stdinListener);
      this.stdinListener = null;
    }

    // Best-effort: disable mouse tracking
    try {
      process.stdout.write(DISABLE_MOUSE);
    } catch {
      // Ignore write errors during cleanup (stdout may be closed)
    }
  }

  isEnabled() { return this.enabled; }
}

/** Singleton mouse manager. */
export const mouse = new MouseManager();
