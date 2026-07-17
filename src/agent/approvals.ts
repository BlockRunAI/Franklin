/**
 * Approval broker — request/response correlation for anything that needs an
 * explicit human decision: trade plans, remote permission prompts, ask-user
 * questions surfaced to a dashboard.
 *
 * The requester parks on a Promise; whoever holds the other end (TUI prompt,
 * panel client over WebSocket, headless auto-policy) resolves it by id. One
 * broker per session.
 */

import crypto from 'node:crypto';

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  kind: 'trade-plan' | 'tool-permission' | 'ask-user';
  /** Short human-readable headline. */
  title: string;
  /** Full body — markdown-ish text rendered by the answering surface. */
  description: string;
  /** Answer choices. Free-text replies map to `message` on the decision. */
  options: string[];
  createdAt: number;
  /** Undefined = wait indefinitely (interactive). */
  timeoutMs?: number;
  /** Kind-specific payload (e.g. the TradePlan object). */
  payload?: unknown;
}

export interface ApprovalDecision {
  /** One of request.options, or 'timeout'. */
  choice: string;
  /** Free-text detail (e.g. requested changes). */
  message?: string;
}

/** What a requester supplies — the broker (or harness) stamps id + createdAt. */
export type ApprovalRequestInput = Omit<ApprovalRequest, 'requestId' | 'createdAt'> & {
  requestId?: string;
  createdAt?: number;
};

export type ApprovalPromptFn = (req: ApprovalRequestInput) => Promise<ApprovalDecision>;

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer?: NodeJS.Timeout;
}

export class ApprovalBroker {
  private pendingMap = new Map<string, PendingApproval>();
  private listeners = new Set<(req: ApprovalRequest) => void>();

  request(req: Omit<ApprovalRequest, 'requestId' | 'createdAt'>): Promise<ApprovalDecision> {
    const request: ApprovalRequest = {
      ...req,
      requestId: crypto.randomBytes(8).toString('hex'),
      createdAt: Date.now(),
    };
    return new Promise<ApprovalDecision>(resolve => {
      const entry: PendingApproval = { request, resolve };
      if (request.timeoutMs && request.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pendingMap.delete(request.requestId);
          resolve({ choice: 'timeout' });
        }, request.timeoutMs);
        entry.timer.unref?.();
      }
      this.pendingMap.set(request.requestId, entry);
      for (const listener of this.listeners) {
        try {
          listener(request);
        } catch {
          /* listener errors must not break the request */
        }
      }
    });
  }

  respond(requestId: string, decision: ApprovalDecision): boolean {
    const entry = this.pendingMap.get(requestId);
    if (!entry) return false;
    this.pendingMap.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(decision);
    return true;
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingMap.values()].map(e => e.request);
  }

  onRequest(listener: (req: ApprovalRequest) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve everything as cancelled — session teardown. */
  cancelAll(reason = 'session ended'): void {
    for (const entry of this.pendingMap.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ choice: 'deny', message: reason });
    }
    this.pendingMap.clear();
  }
}
