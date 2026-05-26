-- SDK integration test bootstrap for the test Supabase project
-- (lmaygzfgyurthaqfzegr.supabase.co).
--
-- Apply once via Supabase Studio → SQL Editor on the test project. Idempotent.
--
-- Creates the minimum unified-api schema the SDK integration test suite
-- depends on (currently: `models` table for getModelConfig). Add more here as
-- additional integration tests require additional tables.

create table if not exists public.models (
  model_id text primary key,
  name text,
  type text,
  author_name text,
  provider_name text not null,
  pricing jsonb,
  aa_id text,
  text_inp boolean default true,
  image_inp boolean default false,
  audio_inp boolean default false,
  video_inp boolean default false,
  pdf_inp boolean default false,
  context_size integer,
  created bigint default -1
);

-- Disable RLS — service-role key bypasses it anyway, and these tests run
-- entirely under bypass auth where there is no user-scoped policy to apply.
alter table public.models disable row level security;

-- Seed the models the SDK integration test suite references. Pricing values
-- are not load-bearing for the upload tests (usage logging is skipped under
-- BYPASS_AUTH) but mirror local-dev values for traceability.
insert into public.models (
  model_id, name, type, author_name, provider_name, pricing,
  aa_id, text_inp, image_inp, audio_inp, video_inp, pdf_inp, context_size, created
) values (
  'gemini-3.1-flash-lite-preview',
  'Gemini 3.1 Flash',
  'text',
  'Google',
  'VertexAI',
  '{"input_token_cost": 0.25, "output_token_cost": 1.5}'::jsonb,
  '598190f8-dc9c-4fea-a7ea-4b81c402ab18',
  true, true, true, true, false,
  1000000,
  -1
) on conflict (model_id) do nothing;
