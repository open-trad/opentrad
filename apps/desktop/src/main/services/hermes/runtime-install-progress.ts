import { HermesRuntimeInstallProgressSchema, IpcChannels } from "@opentrad/shared";

export interface HermesRuntimeProgressWindow {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

export function createHermesRuntimeInstallProgressBroadcaster(
  listWindows: () => readonly HermesRuntimeProgressWindow[],
): (progress: unknown) => void {
  return (progress) => {
    const parsed = HermesRuntimeInstallProgressSchema.safeParse(progress);
    if (!parsed.success) return;

    for (const window of listWindows()) {
      try {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
        window.webContents.send(IpcChannels.HermesRuntimeInstallProgress, parsed.data);
      } catch {
        // A renderer may disappear between the liveness check and send. Progress
        // delivery is best-effort and must never fail the runtime installation.
      }
    }
  };
}
