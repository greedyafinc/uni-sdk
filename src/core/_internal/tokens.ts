export interface TokenSet {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly user_id: string;
  readonly client_id: string;
}

export function isTokenSet(value: unknown): value is TokenSet {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access_token === "string" &&
    typeof v.refresh_token === "string" &&
    typeof v.expires_at === "number" &&
    typeof v.user_id === "string" &&
    typeof v.client_id === "string"
  );
}
