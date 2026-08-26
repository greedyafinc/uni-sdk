export interface DiscoveryRecord {
    readonly port: number;
    readonly pid: number;
    readonly started_at: number;
}
export interface DiscoveryReader {
    read(): Promise<DiscoveryRecord | null>;
}
export declare function defaultDiscoveryPath(): string;
export declare function createDefaultDiscoveryReader(path?: string): DiscoveryReader;
//# sourceMappingURL=discovery.d.ts.map