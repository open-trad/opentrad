// CCTaskHandle 实现：包装 child_process.ChildProcess，
// 暴露 CC stream-json 事件流、cancel、result。

import type { ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { CCEvent, CCResult, CCTaskHandle, ResultData } from "@opentrad/shared";
import { StreamParser } from "@opentrad/stream-parser";

// child_process spawn 以 pipe stdio 得到的具体类型
export type CCChildProcess = ChildProcessByStdio<Writable | null, Readable, Readable>;

export interface CCTaskHandleInit {
  sessionId: string;
  child: CCChildProcess;
  // 触发 onTerminated 后 handle 从 manager 的 activeTasks 里移除
  onTerminated?: (sessionId: string) => void;
}

// 进程 SIGTERM → grace period → SIGKILL 的宽限毫秒。
const CANCEL_GRACE_MS = 1_000;

// 内部状态机：
// - pending: 事件流处于活动、可追加
// - draining: 进程已 exit 但 stdout 可能还在 flush
// - terminated: readline close 完、exit code 已知，迭代器收到 done:true
type State = "pending" | "draining" | "terminated";

export class CCTaskHandleImpl implements CCTaskHandle {
  readonly sessionId: string;
  readonly pid: number;

  private readonly child: CCChildProcess;
  private readonly parser = new StreamParser();
  private readonly eventQueue: CCEvent[] = [];
  private readonly waiters: Array<(r: IteratorResult<CCEvent>) => void> = [];
  private state: State = "pending";

  private finalResultEvent: Extract<CCEvent, { type: "result" }> | null = null;
  private exitCode: number | null = null;
  private cancelRequested = false;

  private readonly resultPromise: Promise<CCResult>;
  private resolveResult!: (r: CCResult) => void;
  private rejectResult!: (err: Error) => void;

  private readonly onTerminated?: (sessionId: string) => void;

  constructor(init: CCTaskHandleInit) {
    this.sessionId = init.sessionId;
    this.child = init.child;
    this.pid = init.child.pid ?? -1;
    this.onTerminated = init.onTerminated;

    this.resultPromise = new Promise<CCResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // 防止"unhandled rejection"：调用方可能只消费 events 而不 await result()。
    this.resultPromise.catch(() => {});

    this.wireStdout();
    this.wireLifecycle();
  }

  // ============ 公共接口 ============

  get events(): AsyncIterable<CCEvent> {
    return {
      [Symbol.asyncIterator]: () => this.createIterator(),
    };
  }

  result(): Promise<CCResult> {
    return this.resultPromise;
  }

  async cancel(): Promise<void> {
    if (this.state === "terminated" || this.cancelRequested) return;
    this.cancelRequested = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;

    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // grace 过了还没退，强杀
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill("SIGKILL");
        }
        resolve();
      }, CANCEL_GRACE_MS);
      const onceExit = () => {
        clearTimeout(timer);
        resolve();
      };
      this.child.once("exit", onceExit);
    });
  }

  // ============ 内部 ============

  private wireStdout(): void {
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      // readline 去掉了 \n，重新加上以复用 StreamParser 的 buffer 规则
      for (const evt of this.parser.parseChunk(`${line}\n`)) {
        this.pushEvent(evt);
      }
    });
    rl.once("close", () => {
      for (const evt of this.parser.flush()) this.pushEvent(evt);
      this.tryFinalize();
    });
    rl.on("error", (err) => {
      // stdout 读错一般跟进程崩溃同时发生，交给 finalize 处理
      // 此处仅记录 unknown 事件保持数据完整
      this.pushEvent({ type: "unknown", raw: `[stdout error] ${err.message}` });
    });
  }

  private wireLifecycle(): void {
    this.child.once("exit", (code, signal) => {
      this.exitCode = code ?? (signal ? 128 + signalNumber(signal) : -1);
      // 进入 draining：等 readline 把 stdout 剩下的 flush 完
      if (this.state === "pending") this.state = "draining";
      this.tryFinalize();
    });
    this.child.once("error", (err) => {
      // spawn 失败（ENOENT 等）通过 error 事件上报
      if (this.state === "terminated") return;
      this.rejectResult(err);
    });
  }

  private pushEvent(evt: CCEvent): void {
    if (evt.type === "result") {
      this.finalResultEvent = evt;
    }
    if (this.waiters.length > 0) {
      const resolver = this.waiters.shift();
      resolver?.({ value: evt, done: false });
    } else {
      this.eventQueue.push(evt);
    }
  }

  // 进程 exit + stdout close 都完成后，关掉迭代器 + resolve/reject result()
  private tryFinalize(): void {
    if (this.state === "terminated") return;
    // 必须两者都完成
    const childDone = this.child.exitCode !== null || this.child.signalCode !== null;
    const stdoutDone = this.child.stdout.readableEnded || this.child.stdout.destroyed;
    if (!childDone || !stdoutDone) return;

    this.state = "terminated";

    // 通知所有等候的 events 迭代器 done
    while (this.waiters.length > 0) {
      const resolver = this.waiters.shift();
      resolver?.({ value: undefined as never, done: true });
    }

    // 产出 CCResult
    const exitCode = this.exitCode ?? -1;
    if (this.finalResultEvent) {
      const data: ResultData = this.finalResultEvent.data;
      const result: CCResult = {
        sessionId: this.finalResultEvent.sessionId,
        status: this.cancelRequested
          ? "cancelled"
          : this.finalResultEvent.subtype === "success"
            ? "success"
            : "error",
        data,
        exitCode,
      };
      this.resolveResult(result);
    } else if (this.cancelRequested) {
      this.rejectResult(new Error(`CC task ${this.sessionId} cancelled before result event`));
    } else {
      this.rejectResult(
        new Error(`CC task ${this.sessionId} exited without result event (exitCode=${exitCode})`),
      );
    }

    this.onTerminated?.(this.sessionId);
  }

  private createIterator(): AsyncIterator<CCEvent> {
    return {
      next: (): Promise<IteratorResult<CCEvent>> => {
        if (this.eventQueue.length > 0) {
          const value = this.eventQueue.shift();
          if (value !== undefined) {
            return Promise.resolve({ value, done: false });
          }
        }
        if (this.state === "terminated") {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<CCEvent>> => {
        // 消费方提前 break 时被调用；此处不 kill 子进程——由上层主动 cancel()。
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

// 把常见信号转为 POSIX 标准退出码片段（仅用于日志，精度不敏感）
function signalNumber(signal: NodeJS.Signals): number {
  const map: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return map[signal] ?? 0;
}
