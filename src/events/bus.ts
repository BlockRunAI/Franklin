import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { FranklinEvent } from './types.js';

type Handler = (event: FranklinEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();
  private logEnabled: boolean;
  private logPath: string;

  constructor(opts: { log?: boolean } = {}) {
    this.logEnabled = opts.log ?? false;
    this.logPath = path.join(os.homedir(), '.blockrun', 'events.jsonl');
  }

  on(type: FranklinEvent['type'], handler: Handler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  off(type: FranklinEvent['type'], handler: Handler): void {
    this.handlers.get(type)?.delete(handler);
  }

  async emit(event: FranklinEvent): Promise<void> {
    if (this.logEnabled) {
      this.appendLog(event);
    }

    const set = this.handlers.get(event.type);
    if (!set) return;

    const promises: Promise<void>[] = [];
    for (const handler of set) {
      const result = handler(event);
      if (result) promises.push(result);
    }
    if (promises.length) await Promise.all(promises);
  }

  clear(): void {
    this.handlers.clear();
  }

  private appendLog(event: FranklinEvent): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n');
    } catch {
      // best-effort logging — don't crash the agent
    }
  }
}

export const bus = new EventBus();
