// A minimal current-value observable, shaped like the SDK's `Session` surface
// (a `get()` for the latest value + a `subscribe()` that returns an
// unsubscribe). A throwing listener is isolated so one bad host callback can't
// break the engine or starve the other listeners.

export class Observable<T> {
  private readonly listeners = new Set<(value: T) => void>();
  private value: T;

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        // A host listener must never break the engine or the other listeners.
      }
    }
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
