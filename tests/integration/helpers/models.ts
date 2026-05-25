/**
 * Cheapest viable model per resource on the local unified-api instance.
 * Selected to minimize provider spend when re-recording cassettes.
 *
 * Prices verified against base-api /models — keep in sync if pricing shifts.
 */
export const TEST_MODELS = {
  /** $0 input / $0.02 output per M tokens. Other free embedding model listed in /models is not actually served. */
  embedding: "intfloat/multilingual-e5-large-instruct",
  /** Free ($0/$0). Use for chat.completions and responses. */
  text: "google/gemma-4-e4b",
  /** $1 / $5 per M tokens. Cheapest Anthropic-shape model for /messages. */
  messages: "claude-haiku-4-5",
  /** $0.0017 per image. */
  image: "Rundiffusion/Juggernaut-Lightning-Flux",
  /** $0.04657 per image. Cheapest model that accepts image input for edits. */
  imageEdit: "google/flash-image-3.1",
} as const;
