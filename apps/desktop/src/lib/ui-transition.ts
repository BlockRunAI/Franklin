import { flushSync } from "react-dom";

let running: ViewTransition | undefined;

// Animate deliberate navigation only. Live prices and streamed replies keep
// updating normally; no component, feed or conversation is recreated for motion.
export function transitionUi(update: () => void, afterUpdate?: () => void): void {
  if (!document.startViewTransition || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.visibilityState === "hidden") {
    update();
    if (afterUpdate) requestAnimationFrame(afterUpdate);
    return;
  }
  running?.skipTransition();
  const transition = document.startViewTransition(() => {
    flushSync(update);
    afterUpdate?.();
  });
  running = transition;
  // Retargeting a running transition rejects ready, but still applies its DOM
  // update. Never discard a user's state change or queue clicks behind motion.
  void transition.ready.catch(() => {});
  void transition.finished.catch(() => {}).finally(() => {
    if (running === transition) running = undefined;
  });
}
