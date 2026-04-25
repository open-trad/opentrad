// xterm.js + node-pty 的桥接组件。
// 责任：mount 时创建一个 PTY + xterm 实例双向喂数据；unmount 时 kill PTY + dispose xterm。
//
// 数据流：
//   PTY stdout (main)  ──IPC pty:data──→ term.write(data)
//   user keypress ──term.onData──→ IPC pty:write
//   resize observer / fit addon ──→ IPC pty:resize
//
// 注意：xterm.js 必须挂在真实 DOM 节点上才能渲染（用 ref + useEffect mount）。
// 容器尺寸变化用 ResizeObserver 触发 fit + IPC resize。

import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type ReactElement, useEffect, useRef } from "react";

export interface TerminalPaneProps {
  // 视觉上的高度；不传时占父容器全高
  height?: number | string;
}

export function TerminalPane({ height = 320 }: TerminalPaneProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: "#0f172a",
        foreground: "#e2e8f0",
        cursor: "#e2e8f0",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fitAddon.fit();

    let ptyId: string | undefined;
    let unsubscribeData: (() => void) | undefined;
    let unsubscribeExit: (() => void) | undefined;
    let disposed = false;

    // 异步启动 PTY；启动失败时在 term 里展示错误，不抛
    void (async () => {
      try {
        const { ptyId: id } = await window.api.pty.spawn({
          args: [],
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) {
          // 已经卸载 → 立刻 kill 刚 spawn 的 PTY 避免泄漏
          await window.api.pty.kill({ ptyId: id });
          return;
        }
        ptyId = id;

        unsubscribeData = window.api.pty.onData((evt) => {
          if (evt.ptyId === id) term.write(evt.data);
        });
        unsubscribeExit = window.api.pty.onExit((evt) => {
          if (evt.ptyId === id) {
            term.write(`\r\n\x1b[33m[shell exited, code=${evt.exitCode}]\x1b[0m\r\n`);
          }
        });

        // 用户键盘输入 → PTY stdin
        term.onData((data) => {
          void window.api.pty.write({ ptyId: id, data });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        term.write(`\x1b[31m[failed to spawn shell: ${message}]\x1b[0m\r\n`);
      }
    })();

    // 容器尺寸变化 → fit + IPC resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // 容器还没真正布局好（display:none 切换瞬间）→ 跳过
      }
      if (ptyId) {
        void window.api.pty.resize({ ptyId, cols: term.cols, rows: term.rows });
      }
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      unsubscribeData?.();
      unsubscribeExit?.();
      if (ptyId) {
        void window.api.pty.kill({ ptyId });
      }
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        height,
        background: "#0f172a",
        padding: "0.5rem",
        boxSizing: "border-box",
      }}
    />
  );
}
