import type { HermesInteractionRequest, HermesInteractionResponse } from "@opentrad/shared";
import { type FormEvent, type ReactElement, useCallback, useEffect, useState } from "react";

export function HermesInteractionOverlay(): ReactElement | null {
  const [queue, setQueue] = useState<HermesInteractionRequest[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return window.api.agent.onHermesInteraction((request) => {
      setQueue((current) => [...current, request]);
    });
  }, []);

  const current = queue[0];
  const respond = useCallback(
    (response: HermesInteractionResponse): void => {
      if (busy) return;
      setBusy(true);
      void window.api.agent
        .respondHermesInteraction(response)
        .catch(() => false)
        .finally(() => {
          setQueue((items) => items.filter((item) => item.requestId !== response.requestId));
          setBusy(false);
        });
    },
    [busy],
  );

  if (!current) return null;
  return (
    <HermesInteractionDialog
      key={current.requestId}
      request={current}
      onRespond={respond}
      disabled={busy}
    />
  );
}

export function HermesInteractionDialog({
  request,
  onRespond,
  disabled = false,
}: {
  request: HermesInteractionRequest;
  onRespond: (response: HermesInteractionResponse) => void;
  disabled?: boolean;
}): ReactElement {
  const [value, setValue] = useState("");

  if (request.kind === "approval") {
    return (
      <Modal title="Hermes 请求执行原生能力">
        <p style={noticeStyle}>
          插件、MCP 与命令会以受信代码运行，并拥有当前执行环境授予的权限。请确认来源和操作内容。
        </p>
        <PromptDetails
          rows={[
            ["插件", request.pluginName],
            ["工具", request.toolName],
            ["命令", request.command],
          ]}
        />
        <div style={actionsStyle}>
          <ActionButton
            disabled={disabled}
            onClick={() =>
              onRespond({ requestId: request.requestId, kind: "approval", choice: "deny" })
            }
          >
            拒绝
          </ActionButton>
          <ActionButton
            disabled={disabled}
            onClick={() =>
              onRespond({ requestId: request.requestId, kind: "approval", choice: "once" })
            }
          >
            仅本次
          </ActionButton>
          <ActionButton
            disabled={disabled}
            onClick={() =>
              onRespond({ requestId: request.requestId, kind: "approval", choice: "session" })
            }
          >
            本会话
          </ActionButton>
          <ActionButton
            primary
            disabled={disabled}
            onClick={() =>
              onRespond({ requestId: request.requestId, kind: "approval", choice: "always" })
            }
          >
            始终允许
          </ActionButton>
        </div>
      </Modal>
    );
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onRespond({ requestId: request.requestId, kind: request.kind, value });
  };
  const isSudo = request.kind === "sudo";
  return (
    <Modal title={isSudo ? "Hermes 需要管理员授权" : "Hermes 请求敏感信息"}>
      <form onSubmit={submit}>
        <PromptDetails
          rows={
            isSudo
              ? [
                  ["说明", request.prompt],
                  ["命令", request.command],
                ]
              : [
                  ["说明", request.prompt],
                  ["变量", request.secretName],
                ]
          }
        />
        <label style={labelStyle}>
          {isSudo ? "macOS 密码" : "Secret"}
          <input
            autoComplete="off"
            disabled={disabled}
            type="password"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            style={inputStyle}
          />
        </label>
        <p style={noticeStyle}>
          {isSudo
            ? "密码仅用于本次 sudo 响应，OpenTrad 不会保存、记录或写入聊天历史。"
            : "Hermes 会将 tool/skill secret 保存到当前私有 Profile Home 中权限为 0600 的 .env；OpenTrad 不会保存、记录或写入聊天历史。"}
        </p>
        <div style={actionsStyle}>
          <ActionButton
            disabled={disabled}
            onClick={() =>
              onRespond({ requestId: request.requestId, kind: request.kind, value: "" })
            }
          >
            取消
          </ActionButton>
          <button type="submit" disabled={disabled || value.length === 0} style={primaryStyle}>
            安全提交
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Modal({ title, children }: { title: string; children: React.ReactNode }): ReactElement {
  return (
    <div style={backdropStyle} role="presentation">
      <section aria-modal="true" aria-label={title} role="dialog" style={dialogStyle}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>{title}</h2>
        {children}
      </section>
    </div>
  );
}

function PromptDetails({
  rows,
}: {
  rows: Array<[string, string | undefined]>;
}): ReactElement | null {
  const visible = rows.filter((row): row is [string, string] => Boolean(row[1]));
  if (visible.length === 0) return null;
  return (
    <dl style={{ margin: "14px 0", display: "grid", gap: 8 }}>
      {visible.map(([label, value]) => (
        <div key={label} style={{ display: "grid", gridTemplateColumns: "52px 1fr", gap: 10 }}>
          <dt style={{ color: "#6b7280" }}>{label}</dt>
          <dd style={detailValueStyle}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
  primary = false,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={primary ? primaryStyle : secondaryStyle}
    >
      {children}
    </button>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 10_000,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "rgba(17, 24, 39, 0.45)",
};

const dialogStyle: React.CSSProperties = {
  width: "min(560px, 100%)",
  borderRadius: 14,
  padding: 20,
  color: "#111827",
  background: "#fff",
  boxShadow: "0 24px 64px rgba(0, 0, 0, 0.24)",
};

const noticeStyle: React.CSSProperties = {
  margin: "12px 0",
  color: "#6b7280",
  fontSize: "0.86rem",
  lineHeight: 1.5,
};

const detailValueStyle: React.CSSProperties = {
  margin: 0,
  overflowWrap: "anywhere",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  whiteSpace: "pre-wrap",
};

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: 7,
  marginTop: 14,
  fontSize: "0.88rem",
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "9px 10px",
  font: "inherit",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 18,
};

const secondaryStyle: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "8px 12px",
  color: "#374151",
  background: "#fff",
  cursor: "pointer",
};

const primaryStyle: React.CSSProperties = {
  ...secondaryStyle,
  borderColor: "#15803d",
  color: "#fff",
  background: "#16a34a",
};
