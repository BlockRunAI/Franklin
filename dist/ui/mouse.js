/**
 * Mouse event support for Ink terminal UI.
 * - SGR extended mouse tracking (DECSET 1000+1002+1006)
 * - Click detection (left click → 'click' event)
 * - Drag detection with text selection (press → motion → release)
 * - Stdout interception for screen text buffer
 * - Clipboard copy on drag-select
 */
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
// ─── Terminal escape sequences ────────────────────────────────────────────
const ENABLE_MOUSE = '\x1b[?1000h' + // Normal mouse tracking (clicks + wheel)
    '\x1b[?1002h' + // Button-motion tracking (drag events)
    '\x1b[?1006h'; // SGR extended format (readable coordinates)
const DISABLE_MOUSE = '\x1b[?1006l' +
    '\x1b[?1002l' +
    '\x1b[?1000l';
// SGR mouse event format: ESC [ < button ; col ; row M (press) or m (release)
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// Strip ANSI escape sequences to get plain text
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][012AB]|\x1b\[[\?=]?\d*[hlJKHfABCDEFGSTm]/g;
function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
}
// ─── Screen Buffer ───────────────────────────────────────────────────────
// Lightweight stdout interceptor that captures rendered text lines.
// Doesn't parse ANSI cursor movement — just stores line content as written.
class ScreenBuffer {
    lines = [];
    maxLines = 500; // ring buffer
    originalWrite = null;
    capturing = false;
    start() {
        if (this.capturing)
            return;
        this.capturing = true;
        this.lines = [];
        // Intercept stdout.write to capture rendered text
        this.originalWrite = process.stdout.write.bind(process.stdout);
        const self = this;
        process.stdout.write = function (chunk, ...args) {
            // Capture the text
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
            self.addText(text);
            // Pass through to original
            return self.originalWrite(chunk, ...args);
        };
    }
    stop() {
        if (!this.capturing)
            return;
        this.capturing = false;
        if (this.originalWrite) {
            process.stdout.write = this.originalWrite;
            this.originalWrite = null;
        }
    }
    addText(text) {
        // Split into lines and store plain text (ANSI stripped)
        const plain = stripAnsi(text);
        const newLines = plain.split('\n');
        for (const line of newLines) {
            if (line.length > 0) {
                this.lines.push(line);
            }
        }
        // Cap ring buffer
        if (this.lines.length > this.maxLines) {
            this.lines = this.lines.slice(-this.maxLines);
        }
    }
    /**
     * Get text between two screen coordinates.
     * Uses the stored text buffer — approximate but good enough for selection.
     */
    getTextInRange(startRow, startCol, endRow, endCol) {
        // Normalize direction
        let r1 = startRow, c1 = startCol, r2 = endRow, c2 = endCol;
        if (r1 > r2 || (r1 === r2 && c1 > c2)) {
            [r1, c1, r2, c2] = [r2, c2, r1, c1];
        }
        // Map screen rows to buffer lines
        // Screen rows are relative to current viewport. Our buffer stores
        // recent lines. We use terminal rows to estimate offset.
        const termRows = process.stdout.rows || 24;
        const bufLen = this.lines.length;
        // Last N lines correspond to the visible screen
        const startIdx = Math.max(0, bufLen - termRows + r1);
        const endIdx = Math.max(0, bufLen - termRows + r2);
        if (startIdx >= bufLen)
            return '';
        const selected = [];
        for (let i = startIdx; i <= Math.min(endIdx, bufLen - 1); i++) {
            const line = this.lines[i] || '';
            if (i === startIdx && i === endIdx) {
                // Single line selection
                selected.push(line.slice(c1, c2 + 1));
            }
            else if (i === startIdx) {
                selected.push(line.slice(c1));
            }
            else if (i === endIdx) {
                selected.push(line.slice(0, c2 + 1));
            }
            else {
                selected.push(line);
            }
        }
        return selected.join('\n').trim();
    }
}
// ─── Clipboard ───────────────────────────────────────────────────────────
function copyToClipboard(text) {
    if (!text)
        return false;
    try {
        if (process.platform === 'darwin') {
            execSync('pbcopy', { input: text, timeout: 2000 });
        }
        else if (process.platform === 'linux') {
            // Try xclip first, then xsel
            try {
                execSync('xclip -selection clipboard', { input: text, timeout: 2000 });
            }
            catch {
                execSync('xsel --clipboard --input', { input: text, timeout: 2000 });
            }
        }
        else if (process.platform === 'win32') {
            execSync('clip', { input: text, timeout: 2000 });
        }
        else {
            return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
class MouseManager extends EventEmitter {
    enabled = false;
    stdinListener = null;
    screen = new ScreenBuffer();
    // Drag state machine
    dragState = 'idle';
    pressPos = { row: 0, col: 0 };
    dragPos = { row: 0, col: 0 };
    /**
     * Enable mouse tracking + screen buffer. Returns cleanup function.
     */
    enable() {
        if (this.enabled)
            return () => { };
        this.enabled = true;
        // Start screen buffer capture
        this.screen.start();
        // Write enable sequences
        process.stdout.write(ENABLE_MOUSE);
        this.stdinListener = (data) => {
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
                const isMotion = (btnCode & 0x20) !== 0; // Bit 5 = motion
                let button;
                if (isWheel) {
                    button = baseBtn === 0 ? 'wheel-up' : 'wheel-down';
                }
                else {
                    button = baseBtn === 0 ? 'left' : baseBtn === 1 ? 'middle' : 'right';
                }
                const action = isMotion ? 'drag' : (isPress ? 'press' : 'release');
                const event = { button, action, col, row };
                this.emit('mouse', event);
                // ── Drag state machine (left button only) ──
                if (button === 'left') {
                    this.handleLeftButton(action, row, col);
                }
            }
        };
        process.stdin.on('data', this.stdinListener);
        return () => this.disable();
    }
    handleLeftButton(action, row, col) {
        switch (this.dragState) {
            case 'idle':
                if (action === 'press') {
                    this.dragState = 'pressing';
                    this.pressPos = { row, col };
                    this.dragPos = { row, col };
                }
                break;
            case 'pressing':
                if (action === 'drag') {
                    // Movement detected — it's a drag, not a click
                    const dist = Math.abs(row - this.pressPos.row) + Math.abs(col - this.pressPos.col);
                    if (dist >= 2) { // Threshold to distinguish drag from click
                        this.dragState = 'dragging';
                        this.dragPos = { row, col };
                        this.emit('drag-start', { ...this.pressPos });
                    }
                }
                else if (action === 'release') {
                    // Press → release without drag = click
                    this.dragState = 'idle';
                    this.emit('click', { button: 'left', action: 'press', col, row });
                }
                break;
            case 'dragging':
                if (action === 'drag') {
                    this.dragPos = { row, col };
                    this.emit('drag-move', { row, col });
                }
                else if (action === 'release') {
                    // Drag complete — extract text and copy to clipboard
                    const text = this.screen.getTextInRange(this.pressPos.row, this.pressPos.col, row, col);
                    this.dragState = 'idle';
                    if (text.length > 0) {
                        const copied = copyToClipboard(text);
                        const selection = {
                            startRow: this.pressPos.row,
                            startCol: this.pressPos.col,
                            endRow: row,
                            endCol: col,
                            text,
                        };
                        this.emit('selection', selection);
                        if (copied) {
                            this.emit('copied', { text, length: text.length });
                        }
                    }
                }
                break;
        }
    }
    /**
     * Disable mouse tracking and clean up.
     */
    disable() {
        if (!this.enabled)
            return;
        this.enabled = false;
        this.dragState = 'idle';
        if (this.stdinListener) {
            process.stdin.removeListener('data', this.stdinListener);
            this.stdinListener = null;
        }
        this.screen.stop();
        try {
            process.stdout.write(DISABLE_MOUSE);
        }
        catch {
            // Ignore write errors during cleanup
        }
    }
    isEnabled() { return this.enabled; }
}
/** Singleton mouse manager. */
export const mouse = new MouseManager();
