import { UnifiedAI } from "./client";

export { UnifiedAI, type UnifiedAIOptions } from "./client";
export {
  UnifiedAIAuthError,
  type UnifiedAIAuthErrorCode,
  UnifiedAIError,
  type UnifiedAIHttpErrorCode,
  UnifiedError,
  type UnifiedErrorCode,
} from "./errors";
export type {
  ListModelsOptions,
  ListModelsResponse,
  Model,
  ModelAuthor,
  ModelType,
} from "./resources/models";
export type {
  GetUsageOptions,
  UsageCredits,
  UsageDaily,
  UsagePeriod,
  UsageResponse,
} from "./resources/usage";
export type {
  ChatCompletionAssistantMessage,
  ChatCompletionChoice,
  ChatCompletionCreateParams,
  ChatCompletionMessage,
  ChatCompletionResponse,
  ChatCompletionResponseFormat,
  ChatCompletionSystemMessage,
  ChatCompletionToolCall,
  ChatCompletionToolChoice,
  ChatCompletionToolDefinition,
  ChatCompletionToolMessage,
  ChatCompletionUsage,
  ChatCompletionUserContentPart,
  ChatCompletionUserMessage,
  ChatCreateOptions,
} from "./resources/chat";
export type {
  ResponseCreateOptions,
  ResponseCreateParams,
  ResponseInputContentPart,
  ResponseInputItem,
  ResponseObject,
  ResponseTool,
  ResponseToolChoice,
} from "./resources/responses";
export type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessageResponse,
  AnthropicTextBlock,
  AnthropicToolChoice,
  AnthropicToolDefinition,
  MessageCreateOptions,
  MessageCreateParams,
} from "./resources/messages";
export {
  getProviderLogo,
  listProviderLogos,
  type LogoTheme,
  type ProviderLogoInput,
} from "./resources/logos";
export type { RequestOptions } from "./core";
export type { Identity } from "./identity";
export type {
  LoopbackHandle,
  LoopbackServer,
  OpenUrl,
} from "./_internal/browser-auth";
export type { DiscoveryReader, DiscoveryRecord } from "./_internal/discovery";
export type { Env, EnvReader } from "./_internal/env";
export type { KeychainAdapter } from "./_internal/keychain";

export default UnifiedAI;
