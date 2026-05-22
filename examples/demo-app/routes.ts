// JSON route handlers. Each returns a Response; app.ts wires them up.

import { type UnifiedError, getProviderLogo } from "../../src/index";
import type { Identity } from "../../src/index";
import { refreshTest, sdk } from "./sdk";

export function me(identity: Identity): Response {
  return Response.json({
    user_id: identity.user_id,
    client_id: identity.client_id,
  });
}

export async function listModels(): Promise<Response> {
  const log: string[] = [];
  const models: Array<{
    id: string;
    type: string;
    owned_by: string;
    logo: string;
    color: string | null;
  }> = [];
  try {
    const { data } = await sdk.models.list({ include: ["author"] });
    log.push(`sdk.models.list() → ${data.length} models`);
    for (const m of data) {
      models.push({
        id: m.id,
        type: m.type,
        owned_by: m.owned_by,
        logo: getProviderLogo(m.model_author?.name ?? m.owned_by),
        color: m.model_author?.color ?? null,
      });
    }
  } catch (e) {
    const err = e as UnifiedError;
    log.push(`models.list failed: ${err.code ?? "error"} — ${err.message}`);
  }
  for (const line of log) console.log(`[models] ${line}`);
  return Response.json({ log, models });
}

export async function getUsage(): Promise<Response> {
  const log: string[] = [];
  let usage: unknown = null;
  try {
    const res = await sdk.usage.get();
    usage = res;
    log.push(
      `sdk.usage.get() → period.cost=$${res.period.cost.toFixed(4)} ` +
        `(${res.period.request_count} reqs, ${res.period.input_tokens} in / ${res.period.output_tokens} out)`,
    );
    log.push(
      `daily: $${res.daily.used.toFixed(4)} / $${res.daily.limit.toFixed(2)}, resets at ${res.daily.resets_at}`,
    );
    log.push(`credits.balance: $${res.credits.balance.toFixed(4)}`);
  } catch (e) {
    const err = e as UnifiedError & { body?: unknown };
    log.push(`usage.get failed: ${err.code ?? "error"} — ${err.message}`);
    if (err.body !== undefined) {
      log.push(`server body: ${JSON.stringify(err.body).slice(0, 400)}`);
    }
  }
  for (const line of log) console.log(`[usage] ${line}`);
  return Response.json({ log, usage });
}

export async function testRefresh(): Promise<Response> {
  const log: string[] = [];

  await sdk.request("/__demo/ping");
  const before = refreshTest.lastBearer;
  log.push(`baseline call → 200 OK (token ${before.slice(0, 12)}…)`);

  refreshTest.forceNext401 = true;
  log.push("forcing next call to 401…");
  try {
    await sdk.request("/__demo/ping");
  } catch (e) {
    const err = e as UnifiedError;
    log.push(`refresh path failed: ${err.code ?? "error"} — ${err.message}`);
    for (const line of log) console.log(`[refresh-test] ${line}`);
    return Response.json({ log });
  }
  const after = refreshTest.lastBearer;
  if (after === before) {
    log.push(`call recovered but token did not rotate (${after.slice(0, 12)}…)`);
  } else {
    log.push(`call recovered after transparent refresh (token ${after.slice(0, 12)}…)`);
  }
  for (const line of log) console.log(`[refresh-test] ${line}`);
  return Response.json({ log });
}

export async function signOut(identity: Identity): Promise<Response> {
  try {
    await sdk.signOut();
  } catch (e) {
    console.error("sign-out failed:", e);
  }
  console.log(`signed out ${identity.user_id}`);
  setTimeout(() => process.exit(0), 250);
  return new Response(null, { status: 204 });
}
