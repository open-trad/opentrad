import { IpcChannels, type PtyDataEvent, type PtyExitEvent } from "@opentrad/shared";
import type { WebContents } from "electron";
import type { PtyManager, PtySpawnOptions } from "./pty-manager";

interface PtySubscriberRouterOptions {
  readonly maxBacklogCharacters?: number;
  readonly maxPendingPtys?: number;
  readonly pendingTtlMs?: number;
}

interface PtyBindingOptions {
  readonly deferUntilAttach?: boolean;
}

type BufferedPtyEvent =
  | { readonly kind: "data"; readonly payload: PtyDataEvent }
  | { readonly kind: "exit"; readonly payload: PtyExitEvent };

interface PendingPty {
  owner?: WebContents;
  attached: boolean;
  readonly events: BufferedPtyEvent[];
  backlogCharacters: number;
  exited: boolean;
  readonly expiry: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_BACKLOG_CHARACTERS = 64 * 1024;
const DEFAULT_MAX_PENDING_PTYS = 64;
const DEFAULT_PENDING_TTL_MS = 30_000;

/**
 * Routes PTYs to their owning renderer. OAuth PTYs stay detached until the dialog has installed
 * both IPC listeners and explicitly attaches; early output is held only in bounded, expiring RAM.
 */
export class PtySubscriberRouter {
  private readonly pending = new Map<string, PendingPty>();
  private readonly closedPtyIds = new Set<string>();
  private readonly closedOrder: string[] = [];
  private readonly maxBacklogCharacters: number;
  private readonly maxPendingPtys: number;
  private readonly pendingTtlMs: number;

  constructor(
    private readonly manager: PtyManager,
    options: PtySubscriberRouterOptions = {},
  ) {
    this.maxBacklogCharacters = positiveInteger(
      options.maxBacklogCharacters,
      DEFAULT_MAX_BACKLOG_CHARACTERS,
    );
    this.maxPendingPtys = positiveInteger(options.maxPendingPtys, DEFAULT_MAX_PENDING_PTYS);
    this.pendingTtlMs = positiveInteger(options.pendingTtlMs, DEFAULT_PENDING_TTL_MS);

    manager.on("data", ({ ptyId, data }) => this.routeData(ptyId, data));
    manager.on("exit", ({ ptyId, exitCode, signal }) => this.routeExit(ptyId, exitCode, signal));
  }

  bind(ptyId: string, owner: WebContents, options: PtyBindingOptions = {}): void {
    if (this.closedPtyIds.has(ptyId) || owner.isDestroyed()) {
      throw new Error("PTY attach is unavailable");
    }
    const pending = this.getOrCreatePending(ptyId);
    if (!pending) throw new Error("PTY attach is unavailable");
    pending.owner = owner;
    pending.attached = options.deferUntilAttach !== true;
    owner.once("destroyed", () => {
      if (this.pending.get(ptyId)?.owner !== owner) return;
      this.complete(ptyId);
      this.manager.kill(ptyId);
    });
    if (pending.attached) this.flush(ptyId, pending);
  }

  spawnAndBind(options: PtySpawnOptions, owner: WebContents): string {
    const ptyId = this.manager.spawn(options);
    try {
      this.bind(ptyId, owner);
      return ptyId;
    } catch (cause) {
      this.manager.kill(ptyId);
      throw cause;
    }
  }

  attach(ptyId: string, owner: WebContents): void {
    const pending = this.pending.get(ptyId);
    if (!pending || pending.owner !== owner || owner.isDestroyed()) {
      throw new Error("PTY attach is unavailable");
    }
    if (pending.attached) return;
    pending.attached = true;
    clearTimeout(pending.expiry);
    this.flush(ptyId, pending);
  }

  assertOwner(ptyId: string, owner: WebContents): void {
    const pending = this.pending.get(ptyId);
    if (!pending || pending.owner !== owner || owner.isDestroyed()) {
      throw new Error("PTY ownership mismatch");
    }
  }

  close(ptyId: string, owner: WebContents): void {
    const pending = this.pending.get(ptyId);
    if (pending?.owner && pending.owner !== owner) {
      throw new Error("PTY ownership mismatch");
    }
    this.complete(ptyId);
  }

  has(ptyId: string): boolean {
    return this.pending.has(ptyId);
  }

  private routeData(ptyId: string, data: string): void {
    if (this.closedPtyIds.has(ptyId)) return;
    const pending = this.getOrCreatePending(ptyId);
    if (!pending || pending.exited) return;
    const payload: PtyDataEvent = { ptyId, data };
    if (pending.owner && pending.attached) {
      this.send(ptyId, pending, IpcChannels.PtyData, payload);
      return;
    }

    const remaining = this.maxBacklogCharacters - pending.backlogCharacters;
    if (remaining <= 0) return;
    const boundedData = data.slice(0, remaining);
    if (!boundedData) return;
    const previous = pending.events.at(-1);
    if (previous?.kind === "data") {
      pending.events[pending.events.length - 1] = {
        kind: "data",
        payload: { ptyId, data: `${previous.payload.data}${boundedData}` },
      };
    } else {
      pending.events.push({ kind: "data", payload: { ptyId, data: boundedData } });
    }
    pending.backlogCharacters += boundedData.length;
  }

  private routeExit(ptyId: string, exitCode: number, signal?: number): void {
    if (this.closedPtyIds.has(ptyId)) return;
    const pending = this.getOrCreatePending(ptyId);
    if (!pending || pending.exited) return;
    const payload: PtyExitEvent = { ptyId, exitCode, signal };
    pending.exited = true;
    if (pending.owner && pending.attached) {
      this.send(ptyId, pending, IpcChannels.PtyExit, payload);
      this.complete(ptyId);
      return;
    }
    pending.events.push({ kind: "exit", payload });
  }

  private flush(ptyId: string, pending: PendingPty): void {
    clearTimeout(pending.expiry);
    const events = pending.events.splice(0);
    pending.backlogCharacters = 0;
    for (const event of events) {
      if (event.kind === "data") {
        if (!this.send(ptyId, pending, IpcChannels.PtyData, event.payload)) return;
      } else {
        if (!this.send(ptyId, pending, IpcChannels.PtyExit, event.payload)) return;
        this.complete(ptyId);
        return;
      }
    }
  }

  private send(
    ptyId: string,
    pending: PendingPty,
    channel: typeof IpcChannels.PtyData | typeof IpcChannels.PtyExit,
    payload: PtyDataEvent | PtyExitEvent,
  ): boolean {
    const owner = pending.owner;
    if (!owner || owner.isDestroyed()) {
      this.complete(ptyId);
      this.manager.kill(ptyId);
      return false;
    }
    try {
      owner.send(channel, payload);
      return true;
    } catch {
      this.complete(ptyId);
      this.manager.kill(ptyId);
      return false;
    }
  }

  private getOrCreatePending(ptyId: string): PendingPty | undefined {
    const existing = this.pending.get(ptyId);
    if (existing) return existing;
    if (this.pending.size >= this.maxPendingPtys) {
      const evictable = [...this.pending.entries()].find(([, value]) => !value.attached);
      if (!evictable) return undefined;
      const [evictedPtyId, evicted] = evictable;
      clearTimeout(evicted.expiry);
      this.pending.delete(evictedPtyId);
      this.markClosed(evictedPtyId);
      this.manager.kill(evictedPtyId);
    }

    const expiry = setTimeout(() => {
      if (!this.pending.has(ptyId)) return;
      this.pending.delete(ptyId);
      this.markClosed(ptyId);
      this.manager.kill(ptyId);
    }, this.pendingTtlMs);
    if (typeof expiry === "object" && "unref" in expiry) expiry.unref();
    const created: PendingPty = {
      attached: false,
      events: [],
      backlogCharacters: 0,
      exited: false,
      expiry,
    };
    this.pending.set(ptyId, created);
    return created;
  }

  private complete(ptyId: string): void {
    const pending = this.pending.get(ptyId);
    if (pending) clearTimeout(pending.expiry);
    this.pending.delete(ptyId);
    this.markClosed(ptyId);
  }

  private markClosed(ptyId: string): void {
    if (this.closedPtyIds.has(ptyId)) return;
    this.closedPtyIds.add(ptyId);
    this.closedOrder.push(ptyId);
    const limit = this.maxPendingPtys * 2;
    while (this.closedOrder.length > limit) {
      const oldest = this.closedOrder.shift();
      if (oldest) this.closedPtyIds.delete(oldest);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}
