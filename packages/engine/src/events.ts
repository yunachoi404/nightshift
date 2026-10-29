import type { Event } from "@nightshift/contract";

export type Listener = (event: Event) => void;

/** In-process fan-out for the SSE stream. Listeners never throw into emitters. */
export class EventBus {
  private listeners = new Set<Listener>();

  emit(event: Event): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must not break the engine
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }
}
