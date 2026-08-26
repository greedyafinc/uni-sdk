export declare class Observable<T> {
    private readonly listeners;
    private value;
    constructor(initial: T);
    get(): T;
    set(value: T): void;
    subscribe(listener: (value: T) => void): () => void;
}
//# sourceMappingURL=observable.d.ts.map