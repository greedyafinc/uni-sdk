import type { Core, RequestOptions } from "../core/core";

export interface UsagePeriod {
  input_tokens: number;
  output_tokens: number;
  request_count: number;
  cost: number;
}

export interface UsageDaily {
  used: number;
  limit: number;
  resets_at: string;
}

export interface UsageCredits {
  balance: number;
}

export interface UsageResponse {
  period: UsagePeriod;
  daily: UsageDaily;
  credits: UsageCredits;
}

export interface GetUsageOptions {
  signal?: AbortSignal;
}

export class Usage {
  constructor(private readonly client: Core) {}

  get(options: GetUsageOptions = {}): Promise<UsageResponse> {
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    return this.client.request<UsageResponse>("/api/v1/usage", req);
  }
}
