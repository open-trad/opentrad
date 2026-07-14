import type { PtyDataEvent, PtyExitEvent } from "@opentrad/shared";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ExternalLink, X } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

const PTY_TAIL_LIMIT = 8_192;
const HTTPS_URL_PATTERN = /https:\/\/[^\s<>"']+/gu;

export interface HermesOAuthPtyDialogProps {
  readonly ptyId: string;
  readonly profileName: string;
  readonly onClose: () => void;
}

interface HermesOAuthPtyAttachApi {
  onData(handler: (event: PtyDataEvent) => void): () => void;
  onExit(handler: (event: PtyExitEvent) => void): () => void;
  attach(request: { readonly ptyId: string }): Promise<void>;
}

interface HermesOAuthPtyHandlers {
  readonly onData: (event: PtyDataEvent) => void;
  readonly onExit: (event: PtyExitEvent) => void;
}

export interface HermesOAuthPtySubscription {
  readonly ready: Promise<void>;
  detach(): void;
}

export interface HermesOAuthPtyKillDeferral {
  cancel(): void;
  schedule(): void;
}

/**
 * Defers destructive PTY cleanup by one task so React StrictMode's development-only
 * setup → cleanup → setup probe can cancel the first cleanup without killing the live process.
 */
export function createHermesOAuthPtyKillDeferral(kill: () => unknown): HermesOAuthPtyKillDeferral {
  let pending: ReturnType<typeof setTimeout> | undefined;
  return Object.freeze({
    cancel() {
      if (pending === undefined) return;
      clearTimeout(pending);
      pending = undefined;
    },
    schedule() {
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = undefined;
        try {
          void Promise.resolve(kill()).catch(() => undefined);
        } catch {
          // Closing an already-exited OAuth process is intentionally idempotent.
        }
      }, 0);
    },
  });
}

/** Installs both renderer listeners before main is allowed to replay any buffered OAuth output. */
export function subscribeAndAttachHermesOAuthPty(
  api: HermesOAuthPtyAttachApi,
  ptyId: string,
  handlers: HermesOAuthPtyHandlers,
): HermesOAuthPtySubscription {
  const offData = api.onData((event) => {
    if (event.ptyId === ptyId) handlers.onData(event);
  });
  const offExit = api.onExit((event) => {
    if (event.ptyId === ptyId) handlers.onExit(event);
  });
  const ready = api.attach({ ptyId });
  return Object.freeze({
    ready,
    detach() {
      offData();
      offExit();
    },
  });
}

/** Keeps only a bounded transient tail so URLs split across PTY chunks can still be detected. */
export function findHermesOAuthUrl(
  previousTail: string,
  chunk: string,
): { url?: string; tail: string } {
  const combined = `${previousTail}${chunk}`;
  const matches = combined.match(HTTPS_URL_PATTERN);
  const candidate = trimPtyUrlSuffix(matches?.at(-1));
  const tail = combined.slice(-PTY_TAIL_LIMIT);
  if (!candidate) return { tail };
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? { url: parsed.toString(), tail } : { tail };
  } catch {
    return { tail };
  }
}

function trimPtyUrlSuffix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let end = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      end = index;
      break;
    }
  }
  return value.slice(0, end).replace(/[),.;]+$/u, "");
}

/** Attached, interactive PTY view for a main-owned official Hermes OAuth process. */
export function HermesOAuthPtyDialog({
  ptyId,
  profileName,
  onClose,
}: HermesOAuthPtyDialogProps): ReactElement {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const tail = useRef("");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const killDeferral = useMemo(
    () =>
      createHermesOAuthPtyKillDeferral(() => window.api.pty.kill({ ptyId }).catch(() => undefined)),
    [ptyId],
  );

  useEffect(() => {
    killDeferral.cancel();
    const element = terminalElement.current;
    if (!element) return;

    const terminal = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: "#0f172a",
        foreground: "#e2e8f0",
        cursor: "#e2e8f0",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        void window.api.shell.openExternal({ url: uri });
      }),
    );
    terminal.open(element);
    fit.fit();

    let disposed = false;
    const subscription = subscribeAndAttachHermesOAuthPty(window.api.pty, ptyId, {
      onData(event) {
        terminal.write(event.data);
        const detected = findHermesOAuthUrl(tail.current, event.data);
        tail.current = detected.tail;
        if (detected.url) setLoginUrl(detected.url);
      },
      onExit(event) {
        setExited(true);
        terminal.write(
          `\r\n\u001b[${event.exitCode === 0 ? "32m[登录流程已结束" : "31m[登录流程退出"}，code=${event.exitCode}]\u001b[0m\r\n`,
        );
      },
    });
    void subscription.ready.catch(() => {
      if (disposed) return;
      setExited(true);
      terminal.write("\r\n\u001b[31m[无法连接登录终端]\u001b[0m\r\n");
    });
    const input = terminal.onData((data) => {
      void window.api.pty.write({ ptyId, data });
    });
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
        void window.api.pty.resize({ ptyId, cols: terminal.cols, rows: terminal.rows });
      } catch {
        // Overlay layout can be between frames while closing.
      }
    });
    resize.observe(element);

    return () => {
      disposed = true;
      tail.current = "";
      subscription.detach();
      input.dispose();
      resize.disconnect();
      terminal.dispose();
      killDeferral.schedule();
    };
  }, [ptyId, killDeferral]);

  return (
    <div style={overlayStyle} role="presentation">
      <section style={dialogStyle} role="dialog" aria-modal="true" aria-label="Hermes OAuth 登录">
        <header style={headerStyle}>
          <div>
            <strong>{profileName}</strong>
            <div style={subtleStyle}>Hermes 官方 OAuth · 独立 Profile Home</div>
          </div>
          <button type="button" onClick={onClose} style={iconButtonStyle} aria-label="关闭登录窗口">
            <X size={18} />
          </button>
        </header>
        <div ref={terminalElement} style={terminalStyle} />
        <footer style={footerStyle}>
          <span style={subtleStyle}>
            {exited
              ? "流程已结束；可关闭窗口。"
              : "按终端提示完成登录；输出不会写入聊天或 SQLite。"}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            {loginUrl ? (
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => void window.api.shell.openExternal({ url: loginUrl })}
              >
                <ExternalLink size={14} />
                在浏览器打开
              </button>
            ) : null}
            <button type="button" onClick={onClose} style={primaryButtonStyle}>
              {exited ? "完成" : "取消"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1500,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "rgba(15, 23, 42, 0.58)",
};

const dialogStyle: React.CSSProperties = {
  width: "min(820px, 92vw)",
  overflow: "hidden",
  borderRadius: 10,
  background: "white",
  boxShadow: "0 24px 80px rgba(15, 23, 42, 0.35)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.8rem 1rem",
  borderBottom: "1px solid #e5e7eb",
};

const terminalStyle: React.CSSProperties = {
  height: 360,
  padding: 8,
  background: "#0f172a",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 16,
  padding: "0.75rem 1rem",
  borderTop: "1px solid #e5e7eb",
};

const subtleStyle: React.CSSProperties = { color: "#64748b", fontSize: "0.78rem" };
const iconButtonStyle: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  padding: 5,
  border: 0,
  borderRadius: 5,
  background: "transparent",
  cursor: "pointer",
};
const secondaryButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "0.45rem 0.7rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  cursor: "pointer",
};
const primaryButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  borderColor: "#2563eb",
  background: "#2563eb",
  color: "white",
};
