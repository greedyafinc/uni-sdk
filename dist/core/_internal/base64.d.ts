/** Encode bytes → standard base64 (padded). */
export declare function bytesToBase64(bytes: Uint8Array): string;
/** Encode bytes → base64url (url-safe alphabet, no padding). */
export declare function bytesToBase64Url(bytes: Uint8Array): string;
/** Decode standard base64 → bytes. Whitespace-tolerant; returns a fresh array. */
export declare function base64ToBytes(b64: string): Uint8Array;
//# sourceMappingURL=base64.d.ts.map