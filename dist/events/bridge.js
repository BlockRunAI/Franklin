import { bus } from './bus.js';
import { addSignal, addPost } from '../narrative/state.js';
export function initBridge() {
    bus.on('signal.detected', (event) => {
        const e = event;
        addSignal({
            asset: e.data.asset,
            direction: e.data.direction,
            confidence: e.data.confidence,
            summary: e.data.summary,
            ts: e.ts,
        });
    });
    bus.on('post.published', (event) => {
        const e = event;
        addPost({
            platform: e.data.platform,
            url: e.data.url,
            text: e.data.text,
            referencesAssets: e.data.referencesAssets,
            ts: e.ts,
        });
    });
}
