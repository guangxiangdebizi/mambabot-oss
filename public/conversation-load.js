// A cancelled response must not clear the spinner or replace a newer conversation.
export class LatestRequest {
  current = null;
  cancel() {
    this.current?.abort();
    this.current = null;
  }
  begin() {
    this.cancel();
    const controller = new AbortController();
    this.current = controller;
    return { signal: controller.signal, current: () => this.current === controller && !controller.signal.aborted };
  }
}

export function mergeWindow(previous, next) {
  const old = new Map(previous.messages.map((m) => [m.id, m]));
  return { ...next, messages: next.messages.map((m) => m.deferred && old.has(m.id) ? old.get(m.id) : m) };
}
