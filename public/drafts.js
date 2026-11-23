// Unsent text per conversation: every chat (and the new-chat page of each project) keeps its own
// composer. Text is remembered on this device; extras such as attachments only while the page is open.

const MAX_SAVED = 100;

export class Drafts {
  constructor(storageKey) {
    this.storageKey = storageKey;
    this.extras = new Map(); // key -> { attachments, askMode, ... } (not persisted)
    try { this.saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { this.saved = {}; }
  }

  /** The draft under `key`: `{ text, ...extras }`, or null when there is none. */
  get(key) {
    const text = this.saved[key]?.text || '';
    const extra = this.extras.get(key);
    return text || extra ? { text, ...extra } : null;
  }

  /** Stores (or, when everything is empty, drops) the draft under `key`. */
  set(key, text, extra = null) {
    if (!key) return;
    if (extra) this.extras.set(key, extra); else this.extras.delete(key);
    const before = this.saved[key]?.text || '';
    if (text.trim()) this.saved[key] = { text, at: Date.now() };
    else delete this.saved[key];
    if (before !== (this.saved[key]?.text || '')) this.persist();
  }

  delete(key) {
    this.extras.delete(key);
    if (this.saved[key]) { delete this.saved[key]; this.persist(); }
  }

  /** Every extra currently kept, e.g. to tell whether an upload still belongs to some draft. */
  allExtras() { return [...this.extras.values()]; }

  persist() {
    const keys = Object.keys(this.saved);
    if (keys.length > MAX_SAVED) {
      keys.sort((a, b) => this.saved[b].at - this.saved[a].at);
      for (const k of keys.slice(MAX_SAVED)) delete this.saved[k];
    }
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.saved)); } catch { /* storage unavailable */ }
  }
}
