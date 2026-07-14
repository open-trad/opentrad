import type { CredentialStore } from "@opentrad/model-providers";
import { type RuntimeAdapter, selectRuntimeKind } from "@opentrad/runtime-adapter";
import {
  createManagedHermesRuntime,
  type HermesRuntimeInstallationGate,
} from "./hermes/managed-runtime";
import { createHermesProfileHomeInitializer } from "./hermes/profile-home";
import { createHermesProfileSecretSource } from "./hermes/profile-secret-source";
import type { HermesRuntimeInstallProgressListener } from "./hermes/runtime-installer";
import {
  createHermesRuntimeComposition,
  type HermesRuntimeCompositionOptions,
} from "./hermes-runtime-composition";

export interface DesktopRuntimeOptions {
  readonly envRuntime: unknown;
  readonly dataRoot: string;
  readonly launcherPath: string;
  readonly listProfiles: () => readonly unknown[];
  readonly credentials: CredentialStore;
  readonly installer: HermesRuntimeInstallationGate;
  readonly onInstallProgress?: HermesRuntimeInstallProgressListener;
  readonly networkEnvironment?: HermesRuntimeCompositionOptions["networkEnvironment"];
  readonly createManager?: NonNullable<HermesRuntimeCompositionOptions["createManager"]>;
}

/** Returns undefined only for the exact OPENTRAD_RUNTIME=legacy emergency switch. */
export function createDesktopRuntime(options: DesktopRuntimeOptions): RuntimeAdapter | undefined {
  if (selectRuntimeKind({ envRuntime: options.envRuntime }) === "legacy") return undefined;
  const runtime = createHermesRuntimeComposition({
    dataRoot: options.dataRoot,
    launcherPath: options.launcherPath,
    acquireProfileSecrets: createHermesProfileSecretSource({
      listProfiles: options.listProfiles,
      credentials: options.credentials,
    }),
    initializeProfileHome: createHermesProfileHomeInitializer({
      listProfiles: options.listProfiles,
    }),
    ...(options.networkEnvironment ? { networkEnvironment: options.networkEnvironment } : {}),
    ...(options.createManager ? { createManager: options.createManager } : {}),
  });
  return createManagedHermesRuntime({
    runtime,
    installer: options.installer,
    onInstallProgress: options.onInstallProgress,
  });
}
