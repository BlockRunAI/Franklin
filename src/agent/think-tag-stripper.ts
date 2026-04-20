/**
 * Streaming parser that splits `<think>…</think>` (and `<thinking>…</thinking>`)
 * tags embedded in a model's text output into separate text / thinking segments.
 *
 * Problem: reasoning models like nemotron, deepseek-r1, qwq emit their chain of
 * thought inline in the text content field — not via the Anthropic `thinking`
 * block nor the OpenAI `reasoning_content` field. If we don't split these,
 * the literal `<think>` tags and the full reasoning leak into the answer UI
 * and into conversation history (wasting context on future turns).
 *
 * Usage:
 *   const s = new ThinkTagStripper();
 *   for (const seg of s.push(chunk)) emit(seg);
 *   for (const seg of s.flush()) emit(seg);
 *
 * Handles tags split across chunk boundaries by holding a small suffix.
 */

export type Segment = { type: 'text' | 'thinking'; text: string };

const OPEN_TAGS = ['<think>', '<thinking>'];
const CLOSE_TAGS = ['</think>', '</thinking>'];

export class ThinkTagStripper {
  private mode: 'text' | 'thinking' = 'text';
  private pending = '';

  push(chunk: string): Segment[] {
    const input = this.pending + chunk;
    this.pending = '';
    const out: Segment[] = [];

    let emitStart = 0;
    let i = 0;

    const emit = (end: number) => {
      if (end > emitStart) {
        out.push({ type: this.mode, text: input.slice(emitStart, end) });
      }
    };

    while (i < input.length) {
      if (input[i] !== '<') { i++; continue; }

      const tags = this.mode === 'text' ? OPEN_TAGS : CLOSE_TAGS;

      // Full-tag match?
      let matched: string | null = null;
      for (const t of tags) {
        if (input.startsWith(t, i)) { matched = t; break; }
      }
      if (matched) {
        emit(i);
        i += matched.length;
        emitStart = i;
        this.mode = this.mode === 'text' ? 'thinking' : 'text';
        continue;
      }

      // Partial match at boundary? Hold back the remainder.
      const rest = input.slice(i);
      const couldStillMatch = tags.some(t => t.length > rest.length && t.startsWith(rest));
      if (couldStillMatch) {
        emit(i);
        this.pending = rest;
        return out;
      }

      i++;
    }

    emit(input.length);
    return out;
  }

  flush(): Segment[] {
    if (!this.pending) return [];
    const segments: Segment[] = [{ type: this.mode, text: this.pending }];
    this.pending = '';
    return segments;
  }
}
