import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Vim-style text input for Franklin's Ink UI.
 * Supports normal/insert mode, motions, operators, counts.
 *
 * Normal mode: h/l/w/b/e/0/$ for movement, i/a/A/I to enter insert, x/dd/dw/D for delete
 * Insert mode: standard text entry, Esc to return to normal mode
 */
import { useState, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
/**
 * Find the start of the next word (Vim 'w' motion).
 */
function nextWord(text, pos) {
    let i = pos;
    // Skip current word chars
    while (i < text.length && /\w/.test(text[i]))
        i++;
    // Skip non-word non-space
    while (i < text.length && /[^\w\s]/.test(text[i]))
        i++;
    // Skip whitespace
    while (i < text.length && /\s/.test(text[i]))
        i++;
    return Math.min(i, text.length);
}
/**
 * Find the start of the previous word (Vim 'b' motion).
 */
function prevWord(text, pos) {
    let i = pos - 1;
    // Skip whitespace backwards
    while (i > 0 && /\s/.test(text[i]))
        i--;
    // Skip non-word non-space backwards
    if (i > 0 && /[^\w\s]/.test(text[i])) {
        while (i > 0 && /[^\w\s]/.test(text[i - 1]))
            i--;
        return i;
    }
    // Skip word chars backwards
    while (i > 0 && /\w/.test(text[i - 1]))
        i--;
    return Math.max(0, i);
}
/**
 * Find the end of the current word (Vim 'e' motion).
 */
function endWord(text, pos) {
    let i = pos + 1;
    // Skip whitespace
    while (i < text.length && /\s/.test(text[i]))
        i++;
    // Move to end of word
    while (i < text.length - 1 && /\w/.test(text[i + 1]))
        i++;
    return Math.min(i, text.length - 1);
}
export default function VimInput({ value, onChange, onSubmit, placeholder = '', focus = true, showMode = true, onModeChange, }) {
    const [mode, setMode] = useState('insert');
    const [cursor, setCursor] = useState(value.length);
    const [cmdBuf, setCmdBuf] = useState(''); // accumulated command buffer (for counts + operators)
    const [yankBuf, setYankBuf] = useState(''); // internal clipboard
    const [undoStack, setUndoStack] = useState([]); // simple undo
    const lastValueRef = useRef(value);
    // Keep cursor in bounds when value changes externally
    const clampedCursor = Math.min(cursor, mode === 'normal' ? Math.max(0, value.length - 1) : value.length);
    const switchMode = useCallback((newMode) => {
        setMode(newMode);
        setCmdBuf('');
        onModeChange?.(newMode);
    }, [onModeChange]);
    const saveUndo = useCallback(() => {
        setUndoStack(prev => [...prev.slice(-20), value]);
    }, [value]);
    const updateValue = useCallback((newVal, newCursor) => {
        onChange(newVal);
        setCursor(Math.max(0, Math.min(newCursor, mode === 'normal' ? Math.max(0, newVal.length - 1) : newVal.length)));
        lastValueRef.current = newVal;
    }, [onChange, mode]);
    useInput((input, key) => {
        if (!focus)
            return;
        // Submit on Enter in any mode
        if (key.return) {
            if (mode === 'normal')
                switchMode('insert');
            onSubmit(value);
            return;
        }
        // ── INSERT MODE ──
        if (mode === 'insert') {
            // Escape → normal mode
            if (key.escape) {
                const newCursor = Math.max(0, clampedCursor - 1);
                setCursor(newCursor);
                switchMode('normal');
                return;
            }
            // Backspace
            if (key.backspace) {
                if (clampedCursor > 0) {
                    saveUndo();
                    updateValue(value.slice(0, clampedCursor - 1) + value.slice(clampedCursor), clampedCursor - 1);
                }
                return;
            }
            // Delete
            if (key.delete) {
                if (clampedCursor < value.length) {
                    saveUndo();
                    updateValue(value.slice(0, clampedCursor) + value.slice(clampedCursor + 1), clampedCursor);
                }
                return;
            }
            // Arrow keys in insert mode
            if (key.leftArrow) {
                setCursor(Math.max(0, clampedCursor - 1));
                return;
            }
            if (key.rightArrow) {
                setCursor(Math.min(value.length, clampedCursor + 1));
                return;
            }
            if (key.upArrow || key.downArrow)
                return; // let parent handle history
            // Ctrl+A: beginning of line
            if (key.ctrl && input === 'a') {
                setCursor(0);
                return;
            }
            // Ctrl+E: end of line
            if (key.ctrl && input === 'e') {
                setCursor(value.length);
                return;
            }
            // Ctrl+W: delete word backward
            if (key.ctrl && input === 'w') {
                const wp = prevWord(value, clampedCursor);
                saveUndo();
                updateValue(value.slice(0, wp) + value.slice(clampedCursor), wp);
                return;
            }
            // Ctrl+U: delete to beginning
            if (key.ctrl && input === 'u') {
                saveUndo();
                setYankBuf(value.slice(0, clampedCursor));
                updateValue(value.slice(clampedCursor), 0);
                return;
            }
            // Ctrl+K: delete to end
            if (key.ctrl && input === 'k') {
                saveUndo();
                setYankBuf(value.slice(clampedCursor));
                updateValue(value.slice(0, clampedCursor), clampedCursor);
                return;
            }
            // Skip control chars and tab
            if (key.ctrl || key.meta || key.tab)
                return;
            // Regular character input
            if (input) {
                saveUndo();
                updateValue(value.slice(0, clampedCursor) + input + value.slice(clampedCursor), clampedCursor + input.length);
            }
            return;
        }
        // ── NORMAL MODE ──
        if (key.escape) {
            setCmdBuf('');
            return;
        }
        // Arrow keys work in normal mode too
        if (key.leftArrow) {
            setCursor(Math.max(0, clampedCursor - 1));
            return;
        }
        if (key.rightArrow) {
            setCursor(Math.min(Math.max(0, value.length - 1), clampedCursor + 1));
            return;
        }
        if (key.upArrow || key.downArrow)
            return; // let parent handle
        // Backspace in normal mode = left
        if (key.backspace) {
            setCursor(Math.max(0, clampedCursor - 1));
            return;
        }
        // Build command buffer
        const fullCmd = cmdBuf + input;
        // Parse count prefix
        const countMatch = fullCmd.match(/^(\d+)(.*)/);
        const count = countMatch ? parseInt(countMatch[1]) : 1;
        const cmd = countMatch ? countMatch[2] : fullCmd;
        // ── Mode switches ──
        if (cmd === 'i') {
            switchMode('insert');
            return;
        }
        if (cmd === 'a') {
            setCursor(Math.min(value.length, clampedCursor + 1));
            switchMode('insert');
            return;
        }
        if (cmd === 'I') {
            setCursor(0);
            switchMode('insert');
            return;
        }
        if (cmd === 'A') {
            setCursor(value.length);
            switchMode('insert');
            return;
        }
        if (cmd === 's') { // substitute: delete char and enter insert
            saveUndo();
            updateValue(value.slice(0, clampedCursor) + value.slice(clampedCursor + 1), clampedCursor);
            switchMode('insert');
            return;
        }
        if (cmd === 'S' || cmd === 'cc') { // substitute line
            saveUndo();
            setYankBuf(value);
            updateValue('', 0);
            switchMode('insert');
            return;
        }
        // ── Navigation ──
        if (cmd === 'h') {
            setCursor(Math.max(0, clampedCursor - count));
            setCmdBuf('');
            return;
        }
        if (cmd === 'l') {
            setCursor(Math.min(Math.max(0, value.length - 1), clampedCursor + count));
            setCmdBuf('');
            return;
        }
        if (cmd === 'w') {
            let pos = clampedCursor;
            for (let n = 0; n < count; n++)
                pos = nextWord(value, pos);
            setCursor(Math.min(pos, Math.max(0, value.length - 1)));
            setCmdBuf('');
            return;
        }
        if (cmd === 'b') {
            let pos = clampedCursor;
            for (let n = 0; n < count; n++)
                pos = prevWord(value, pos);
            setCursor(pos);
            setCmdBuf('');
            return;
        }
        if (cmd === 'e') {
            let pos = clampedCursor;
            for (let n = 0; n < count; n++)
                pos = endWord(value, pos);
            setCursor(Math.min(pos, Math.max(0, value.length - 1)));
            setCmdBuf('');
            return;
        }
        if (cmd === '0') {
            // Only if not building a count (e.g., "10w" — "0" is part of count)
            if (!countMatch || countMatch[2] === '0') {
                setCursor(0);
                setCmdBuf('');
                return;
            }
        }
        if (cmd === '$') {
            setCursor(Math.max(0, value.length - 1));
            setCmdBuf('');
            return;
        }
        if (cmd === '^') {
            const firstNonSpace = value.search(/\S/);
            setCursor(firstNonSpace >= 0 ? firstNonSpace : 0);
            setCmdBuf('');
            return;
        }
        // ── Editing ──
        if (cmd === 'x') {
            if (value.length > 0) {
                saveUndo();
                const deleted = value.slice(clampedCursor, clampedCursor + count);
                setYankBuf(deleted);
                const newVal = value.slice(0, clampedCursor) + value.slice(clampedCursor + count);
                updateValue(newVal, Math.min(clampedCursor, Math.max(0, newVal.length - 1)));
            }
            setCmdBuf('');
            return;
        }
        if (cmd === 'X') {
            if (clampedCursor > 0) {
                saveUndo();
                const start = Math.max(0, clampedCursor - count);
                setYankBuf(value.slice(start, clampedCursor));
                updateValue(value.slice(0, start) + value.slice(clampedCursor), start);
            }
            setCmdBuf('');
            return;
        }
        if (cmd === 'dd') {
            saveUndo();
            setYankBuf(value);
            updateValue('', 0);
            setCmdBuf('');
            return;
        }
        if (cmd === 'D') {
            saveUndo();
            setYankBuf(value.slice(clampedCursor));
            updateValue(value.slice(0, clampedCursor), Math.max(0, clampedCursor - 1));
            setCmdBuf('');
            return;
        }
        if (cmd === 'C') { // change to end of line
            saveUndo();
            setYankBuf(value.slice(clampedCursor));
            updateValue(value.slice(0, clampedCursor), clampedCursor);
            switchMode('insert');
            return;
        }
        if (cmd === 'dw') {
            saveUndo();
            let pos = clampedCursor;
            for (let n = 0; n < count; n++)
                pos = nextWord(value, pos);
            setYankBuf(value.slice(clampedCursor, pos));
            updateValue(value.slice(0, clampedCursor) + value.slice(pos), clampedCursor);
            setCmdBuf('');
            return;
        }
        if (cmd === 'db') {
            saveUndo();
            let pos = clampedCursor;
            for (let n = 0; n < count; n++)
                pos = prevWord(value, pos);
            setYankBuf(value.slice(pos, clampedCursor));
            updateValue(value.slice(0, pos) + value.slice(clampedCursor), pos);
            setCmdBuf('');
            return;
        }
        if (cmd === 'cw') { // change word
            saveUndo();
            let pos = clampedCursor;
            for (let n = 0; n < count; n++)
                pos = nextWord(value, pos);
            setYankBuf(value.slice(clampedCursor, pos));
            updateValue(value.slice(0, clampedCursor) + value.slice(pos), clampedCursor);
            switchMode('insert');
            return;
        }
        if (cmd === 'cb') { // change back
            saveUndo();
            let pos = clampedCursor;
            for (let n = 0; n < count; n++)
                pos = prevWord(value, pos);
            setYankBuf(value.slice(pos, clampedCursor));
            updateValue(value.slice(0, pos) + value.slice(clampedCursor), pos);
            switchMode('insert');
            return;
        }
        // ── Yank & Paste ──
        if (cmd === 'yy') {
            setYankBuf(value);
            setCmdBuf('');
            return;
        }
        if (cmd === 'yw') {
            const pos = nextWord(value, clampedCursor);
            setYankBuf(value.slice(clampedCursor, pos));
            setCmdBuf('');
            return;
        }
        if (cmd === 'p') {
            if (yankBuf) {
                saveUndo();
                const insertAt = Math.min(clampedCursor + 1, value.length);
                updateValue(value.slice(0, insertAt) + yankBuf + value.slice(insertAt), insertAt + yankBuf.length - 1);
            }
            setCmdBuf('');
            return;
        }
        if (cmd === 'P') {
            if (yankBuf) {
                saveUndo();
                updateValue(value.slice(0, clampedCursor) + yankBuf + value.slice(clampedCursor), clampedCursor + yankBuf.length - 1);
            }
            setCmdBuf('');
            return;
        }
        // ── Undo ──
        if (cmd === 'u') {
            if (undoStack.length > 0) {
                const prev = undoStack[undoStack.length - 1];
                setUndoStack(s => s.slice(0, -1));
                onChange(prev);
                setCursor(Math.min(clampedCursor, Math.max(0, prev.length - 1)));
                lastValueRef.current = prev;
            }
            setCmdBuf('');
            return;
        }
        // ── Accumulate partial commands ──
        // Valid prefixes for multi-key commands
        if (/^\d+$/.test(fullCmd)) {
            setCmdBuf(fullCmd);
            return;
        } // count accumulating
        if (fullCmd === 'd' || fullCmd === 'c' || fullCmd === 'y') {
            setCmdBuf(fullCmd);
            return;
        } // operator pending
        if (/^\d+[dcy]$/.test(fullCmd)) {
            setCmdBuf(fullCmd);
            return;
        } // count + operator
        // Unknown command — reset
        setCmdBuf('');
    }, { isActive: focus });
    // ── Render ──
    const displayValue = value || (mode === 'insert' ? placeholder : '');
    const isEmpty = !value;
    // Build the displayed text with cursor
    let rendered;
    if (isEmpty && mode === 'insert') {
        rendered = (_jsx(Text, { dimColor: true, children: placeholder }));
    }
    else {
        // Split text around cursor for highlighting
        const before = displayValue.slice(0, clampedCursor);
        const atCursor = displayValue[clampedCursor] || ' ';
        const after = displayValue.slice(clampedCursor + 1);
        rendered = (_jsxs(Text, { children: [before, _jsx(Text, { inverse: focus, bold: mode === 'normal', children: atCursor }), after] }));
    }
    return (_jsxs(Box, { children: [showMode && mode === 'normal' && (_jsx(Text, { color: "yellow", bold: true, children: "[N] " })), rendered, cmdBuf && mode === 'normal' && (_jsxs(Text, { dimColor: true, children: [" ", cmdBuf] }))] }));
}
