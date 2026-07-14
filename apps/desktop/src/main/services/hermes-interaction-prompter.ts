import { randomUUID } from "node:crypto";
import type { RuntimeApprovalChoice } from "@opentrad/runtime-adapter";
import {
  type HermesInteractionRequest,
  HermesInteractionRequestSchema,
  type HermesInteractionResponse,
  HermesInteractionResponseSchema,
  IpcChannels,
} from "@opentrad/shared";
import type { BrowserWindow } from "electron";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

type HermesInteractionKind = HermesInteractionRequest["kind"];

export type HermesInteractionPromptInput<Kind extends HermesInteractionKind> = Omit<
  Extract<HermesInteractionRequest, { kind: Kind }>,
  "requestId"
>;

export interface HermesInteractionPromptService {
  requestApproval(input: HermesInteractionPromptInput<"approval">): Promise<RuntimeApprovalChoice>;
  requestSudo(input: HermesInteractionPromptInput<"sudo">): Promise<string>;
  requestSecret(input: HermesInteractionPromptInput<"secret">): Promise<string>;
  handleResponse(raw: unknown, sourceId: number): boolean;
  cleanupAll(): void;
}

interface PendingInteraction {
  readonly kind: HermesInteractionKind;
  readonly sourceId: number;
  readonly fallback: RuntimeApprovalChoice | "";
  readonly resolve: (value: RuntimeApprovalChoice | string) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly window: BrowserWindow;
  readonly onClosed: () => void;
}

/**
 * Owns one-shot Renderer prompts for native Hermes control-plane requests.
 * Upstream request identities stay in AgentService; only random UI request IDs cross IPC.
 */
export class HermesInteractionPrompter implements HermesInteractionPromptService {
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  requestApproval(input: HermesInteractionPromptInput<"approval">): Promise<RuntimeApprovalChoice> {
    return this.request(input, "deny") as Promise<RuntimeApprovalChoice>;
  }

  requestSudo(input: HermesInteractionPromptInput<"sudo">): Promise<string> {
    return this.request(input, "");
  }

  requestSecret(input: HermesInteractionPromptInput<"secret">): Promise<string> {
    return this.request(input, "");
  }

  handleResponse(raw: unknown, sourceId: number): boolean {
    const requestId = requestIdOf(raw);
    if (!requestId) return false;
    const pending = this.pending.get(requestId);
    if (!pending || pending.sourceId !== sourceId) return false;

    const parsed = HermesInteractionResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== pending.kind) {
      this.settle(requestId, pending.fallback);
      return false;
    }

    this.settle(requestId, responseValue(parsed.data));
    return true;
  }

  cleanupAll(): void {
    for (const [requestId, pending] of [...this.pending]) {
      this.settle(requestId, pending.fallback);
    }
  }

  private request(
    input: HermesInteractionPromptInput<HermesInteractionKind>,
    fallback: RuntimeApprovalChoice | "",
  ): Promise<RuntimeApprovalChoice | string> {
    const request = HermesInteractionRequestSchema.parse({ ...input, requestId: randomUUID() });
    let window: BrowserWindow | null;
    try {
      window = this.getMainWindow();
      if (window?.isDestroyed() || window?.webContents.isDestroyed()) window = null;
    } catch {
      window = null;
    }
    if (!window) {
      return Promise.resolve(fallback);
    }

    return new Promise<RuntimeApprovalChoice | string>((resolve) => {
      const onClosed = (): void => {
        this.settle(request.requestId, fallback);
      };
      const timer = setTimeout(onClosed, this.timeoutMs);
      this.pending.set(request.requestId, {
        kind: request.kind,
        sourceId: window.webContents.id,
        fallback,
        resolve,
        timer,
        window,
        onClosed,
      });
      window.once("closed", onClosed);
      try {
        window.webContents.send(IpcChannels.AgentHermesInteractionRequest, request);
      } catch {
        this.settle(request.requestId, fallback);
      }
    });
  }

  private settle(requestId: string, value: RuntimeApprovalChoice | string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.window.removeListener("closed", pending.onClosed);
    pending.resolve(value);
  }
}

function requestIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const requestId = Reflect.get(value, "requestId");
  return typeof requestId === "string" ? requestId : undefined;
}

function responseValue(response: HermesInteractionResponse): RuntimeApprovalChoice | string {
  return response.kind === "approval" ? response.choice : response.value;
}
