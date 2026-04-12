import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
export class EventBus {
    handlers = new Map();
    logEnabled;
    logPath;
    constructor(opts = {}) {
        this.logEnabled = opts.log ?? false;
        this.logPath = path.join(os.homedir(), '.blockrun', 'events.jsonl');
    }
    on(type, handler) {
        let set = this.handlers.get(type);
        if (!set) {
            set = new Set();
            this.handlers.set(type, set);
        }
        set.add(handler);
    }
    off(type, handler) {
        this.handlers.get(type)?.delete(handler);
    }
    async emit(event) {
        if (this.logEnabled) {
            this.appendLog(event);
        }
        const set = this.handlers.get(event.type);
        if (!set)
            return;
        const promises = [];
        for (const handler of set) {
            const result = handler(event);
            if (result)
                promises.push(result);
        }
        if (promises.length)
            await Promise.all(promises);
    }
    clear() {
        this.handlers.clear();
    }
    appendLog(event) {
        try {
            const dir = path.dirname(this.logPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n');
        }
        catch {
            // best-effort logging — don't crash the agent
        }
    }
}
export const bus = new EventBus();
