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
