/**
 * Vim-style text input for Franklin's Ink UI.
 * Supports normal/insert mode, motions, operators, counts.
 *
 * Normal mode: h/l/w/b/e/0/$ for movement, i/a/A/I to enter insert, x/dd/dw/D for delete
 * Insert mode: standard text entry, Esc to return to normal mode
 */
export type VimMode = 'insert' | 'normal';
interface VimInputProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: (value: string) => void;
    placeholder?: string;
    focus?: boolean;
    showMode?: boolean;
    onModeChange?: (mode: VimMode) => void;
}
export default function VimInput({ value, onChange, onSubmit, placeholder, focus, showMode, onModeChange, }: VimInputProps): import("react/jsx-runtime").JSX.Element;
export {};
