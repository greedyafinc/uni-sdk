import { bytesToBase64Url } from "./base64";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function randomString(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    const b = bytes[i] ?? 0;
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

export function generateVerifier(): string {
  return randomString(64);
}

export function generateState(): string {
  return randomString(32);
}

export async function challengeFor(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToBase64Url(new Uint8Array(digest));
}
