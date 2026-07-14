export type ShutdownTrigger = "before-quit" | "window-close" | "SIGINT" | "SIGTERM";

export interface ShutdownCoordinatorOptions {
  cleanup: () => Promise<void>;
  exit: (code: number) => void;
  onCleanupError?: (error: unknown, trigger: ShutdownTrigger) => void;
}

export interface ShutdownCoordinator {
  readonly isQuitting: boolean;
  canCreateMainWindow(): boolean;
  requestShutdown(trigger: ShutdownTrigger): Promise<void>;
}

export function createShutdownCoordinator(
  options: ShutdownCoordinatorOptions,
): ShutdownCoordinator {
  let quitting = false;
  let shutdownPromise: Promise<void> | undefined;

  return {
    get isQuitting() {
      return quitting;
    },

    canCreateMainWindow() {
      return !quitting;
    },

    requestShutdown(trigger) {
      quitting = true;
      if (!shutdownPromise) {
        // Defer cleanup by one microtask so the shared Promise is installed before
        // any cleanup callback can synchronously trigger another shutdown path.
        shutdownPromise = Promise.resolve()
          .then(options.cleanup)
          .catch((error: unknown) => {
            try {
              options.onCleanupError?.(error, trigger);
            } catch {
              // Logging must never prevent the final process exit.
            }
          })
          .finally(() => {
            options.exit(0);
          });
      }
      return shutdownPromise;
    },
  };
}
