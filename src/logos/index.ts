// Brand-logo entry — import from "@unifiedai/sdk/logos".
//
// Deliberately separate from the main browser/node entries: the generated
// logo table (src/resources/logos.generated.ts) is ~58 KB of data-URI strings,
// so keeping it out of the root entry keeps the core bundle lean. Everything
// here is browser-safe.
export {
  getProviderLogo,
  getModelLogo,
  listProviderLogos,
} from "../resources/logos";
export type {
  LogoTheme,
  ProviderLogoInput,
  ModelLogoInput,
} from "../resources/logos";
