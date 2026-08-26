/** Identity key for one record: ["ns","collection","id"]. */
export declare function pkOf(ns: string, collection: string, id: string): string;
/** Bucket key grouping a collection's records: ["ns","collection"]. */
export declare function cpkOf(ns: string, collection: string): string;
/** Identity key for one version snapshot: ["ns","collection","id",version]. */
export declare function vpkOf(ns: string, collection: string, id: string, version: number): string;
//# sourceMappingURL=keys.d.ts.map