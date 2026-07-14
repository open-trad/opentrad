import {
  type CredentialStore,
  type ProviderProfile,
  ProviderProfileSchema,
} from "@opentrad/model-providers";
import type { HermesProviderProfileSecretSource } from "./provider-capability-issuer";
import type { HermesSidecarBinding } from "./sidecar-manager";

export interface HermesProfileSecretSourceOptions {
  readonly listProfiles: () => readonly unknown[];
  readonly credentials: CredentialStore;
}

export class HermesProfileSecretSourceError extends Error {
  readonly code = "HERMES_PROFILE_AUTH_UNAVAILABLE";

  constructor() {
    super("Hermes Provider Profile authentication is unavailable");
    this.name = "HermesProfileSecretSourceError";
  }
}

export function createHermesProfileSecretSource(
  options: HermesProfileSecretSourceOptions,
): HermesProviderProfileSecretSource {
  const listProfiles = options?.listProfiles;
  const credentials = options?.credentials;
  if (typeof listProfiles !== "function" || !credentials || typeof credentials.get !== "function") {
    throw new HermesProfileSecretSourceError();
  }

  return async (binding) => {
    try {
      const profile = findProfile(listProfiles(), binding.profileId);
      assertBindingMatchesProfile(binding, profile);
      if (profile.hermes.authMode === "oauth") {
        return Object.freeze({ apiKey: null, baseUrl: null });
      }
      if (!profile.credentialRef) throw new Error();
      const apiKey = await credentials.get(profile.credentialRef);
      if (!apiKey) throw new Error();
      return Object.freeze({
        apiKey,
        baseUrl: profile.baseUrl ?? null,
      });
    } catch {
      throw new HermesProfileSecretSourceError();
    }
  };
}

function findProfile(rows: readonly unknown[], profileId: string): ProviderProfile {
  for (const row of rows) {
    try {
      const profile = ProviderProfileSchema.parse(row);
      if (profile.id === profileId) return profile;
    } catch {
      // A corrupt unrelated row must not prevent a valid Profile from being selected.
    }
  }
  throw new Error();
}

function assertBindingMatchesProfile(
  binding: HermesSidecarBinding,
  profile: ProviderProfile,
): void {
  const hermes = profile.hermes;
  if (
    binding.profileId !== profile.id ||
    binding.providerSlug !== hermes.providerSlug ||
    binding.authMode !== hermes.authMode ||
    binding.apiMode !== hermes.apiMode ||
    binding.executionBackend !== hermes.executionBackend ||
    binding.model !== profile.model
  ) {
    throw new Error();
  }
}
