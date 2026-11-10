type Handler<T> = (payload: T) => void;

/** Minimal typed event emitter */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { (fn as Handler<Events[K]>)(payload); } catch (e) { console.error(`handler for ${String(type)} failed`, e); }
    }
  }
}
