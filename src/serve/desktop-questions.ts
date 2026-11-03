/** Free-text questions have their own protocol; answers never grant tool permissions. */
export class DesktopQuestions<Owner> {
  private sequence = 0;
  private pending = new Map<string, { owner: Owner; finish: (answer: string) => void }>();
  constructor(private timeoutMs = 15 * 60 * 1000) {}

  request(owner: Owner, question: string, options: string[] | undefined,
    emit: (kind: 'agent.questionAsk' | 'agent.questionClosed', payload: object) => void): Promise<string> {
    const askId = `question_${++this.sequence}`;
    return new Promise(resolve => {
      const finish = (answer: string) => {
        if (!this.pending.delete(askId)) return;
        clearTimeout(timer);
        emit('agent.questionClosed', { askId });
        resolve(answer);
      };
      const timer = setTimeout(() => finish(''), this.timeoutMs);
      timer.unref?.();
      this.pending.set(askId, { owner, finish });
      emit('agent.questionAsk', { askId, question, options: options ?? [] });
    });
  }

  respond(owner: Owner, askId: unknown, answer: unknown): boolean {
    if (typeof askId !== 'string' || typeof answer !== 'string' || answer.length > 16_000) return false;
    const request = this.pending.get(askId);
    if (!request || request.owner !== owner) return false;
    request.finish(answer);
    return true;
  }

  cancel(owner: Owner): void {
    for (const request of [...this.pending.values()]) {
      if (request.owner === owner) request.finish('');
    }
  }
}
