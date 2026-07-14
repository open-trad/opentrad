import type {
  RuntimeAdapter,
  RuntimeApprovalChoice,
  RuntimeBinding,
  RuntimeCrashListener,
  RuntimeCreateInput,
  RuntimeEventSink,
  RuntimeReady,
  RuntimeResumeInput,
} from "@opentrad/runtime-adapter";
import type {
  HermesRuntimeInstallProgressListener,
  InstalledHermesRuntime,
} from "./runtime-installer";

export interface HermesRuntimeInstallationGate {
  ensureInstalled(
    onProgress?: HermesRuntimeInstallProgressListener,
  ): Promise<InstalledHermesRuntime>;
}

export interface ManagedHermesRuntimeOptions {
  readonly runtime: RuntimeAdapter;
  readonly installer: HermesRuntimeInstallationGate;
  readonly onInstallProgress?: HermesRuntimeInstallProgressListener;
}

export function createManagedHermesRuntime(options: ManagedHermesRuntimeOptions): RuntimeAdapter {
  if (options.runtime.kind !== "hermes") throw new Error("Managed Hermes runtime is invalid");
  let installation: Promise<InstalledHermesRuntime> | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const respondApproval = options.runtime.respondApproval?.bind(options.runtime);
  const respondSudo = options.runtime.respondSudo?.bind(options.runtime);
  const respondSecret = options.runtime.respondSecret?.bind(options.runtime);
  const invalidateProfile = options.runtime.invalidateProfile?.bind(options.runtime);

  const assertActive = (): void => {
    if (disposed) throw new Error("Managed Hermes runtime is disposed");
  };

  const invoke = <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      assertActive();
      return operation();
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const ensureInstalled = (): Promise<InstalledHermesRuntime> => {
    if (disposed) return Promise.reject(new Error("Managed Hermes runtime is disposed"));
    if (!installation) {
      const attempt = options.installer
        .ensureInstalled(options.onInstallProgress)
        .catch((error) => {
          if (installation === attempt) installation = undefined;
          throw error;
        });
      installation = attempt;
    }
    return installation;
  };

  const afterInstall = async <T>(operation: () => Promise<T>): Promise<T> => {
    await ensureInstalled();
    assertActive();
    return operation();
  };

  const interactionMethods: Pick<
    RuntimeAdapter,
    "respondApproval" | "respondSudo" | "respondSecret"
  > = {
    ...(respondApproval
      ? {
          respondApproval: (
            binding: RuntimeBinding,
            choice: RuntimeApprovalChoice,
          ): Promise<void> => invoke(() => respondApproval(binding, choice)),
        }
      : {}),
    ...(respondSudo
      ? {
          respondSudo: (
            binding: RuntimeBinding,
            requestId: string,
            password: string,
          ): Promise<void> => invoke(() => respondSudo(binding, requestId, password)),
        }
      : {}),
    ...(respondSecret
      ? {
          respondSecret: (
            binding: RuntimeBinding,
            requestId: string,
            value: string,
          ): Promise<void> => invoke(() => respondSecret(binding, requestId, value)),
        }
      : {}),
  };

  const profileLifecycleMethods: Pick<RuntimeAdapter, "invalidateProfile"> = invalidateProfile
    ? {
        invalidateProfile: (profileId: string): Promise<void> =>
          invoke(() => invalidateProfile(profileId)),
      }
    : {};

  return Object.freeze({
    kind: "hermes" as const,
    ready: (): Promise<RuntimeReady> => afterInstall(() => options.runtime.ready()),
    create: (input: RuntimeCreateInput): Promise<RuntimeBinding> =>
      afterInstall(() => options.runtime.create(input)),
    resume: (input: RuntimeResumeInput): Promise<RuntimeBinding> =>
      afterInstall(() => options.runtime.resume(input)),
    stream: (binding: RuntimeBinding, prompt: string, emit: RuntimeEventSink): Promise<void> =>
      invoke(() => options.runtime.stream(binding, prompt, emit)),
    interrupt: (binding: RuntimeBinding): Promise<void> =>
      invoke(() => options.runtime.interrupt(binding)),
    close: (binding: RuntimeBinding): Promise<void> => invoke(() => options.runtime.close(binding)),
    ...interactionMethods,
    ...profileLifecycleMethods,
    onCrash: (listener: RuntimeCrashListener): (() => void) => {
      assertActive();
      return options.runtime.onCrash(listener);
    },
    dispose: (): Promise<void> => {
      if (disposePromise) return disposePromise;
      disposed = true;
      const disposing = Promise.resolve(installation)
        .catch(() => undefined)
        .then(() => options.runtime.dispose());
      disposePromise = disposing;
      return disposing;
    },
  });
}
