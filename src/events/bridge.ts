import { bus } from './bus.js';
import type { FranklinEvent, SignalDetectedEvent, PostPublishedEvent } from './types.js';
import { addSignal, addPost } from '../narrative/state.js';

export function initBridge(): void {
  bus.on('signal.detected', (event: FranklinEvent) => {
    const e = event as SignalDetectedEvent;
    addSignal({
      asset: e.data.asset,
      direction: e.data.direction,
      confidence: e.data.confidence,
      summary: e.data.summary,
      ts: e.ts,
    });
  });

  bus.on('post.published', (event: FranklinEvent) => {
    const e = event as PostPublishedEvent;
    addPost({
      platform: e.data.platform,
      url: e.data.url,
      text: e.data.text,
      referencesAssets: e.data.referencesAssets,
      ts: e.ts,
    });
  });
}
