// LoginStep 占位（M1 #22 / open-trad/opentrad#22 落地真实实现）。
// M1 #21 范围内只显示提示,允许"已登录"或"跳过"推进。

import type { CCStatus } from "@opentrad/shared";
import type { ReactElement } from "react";

export interface LoginStepPlaceholderProps {
  status: CCStatus;
  onLoggedIn: () => void;
  onSkip: () => void;
}

export function LoginStepPlaceholder({
  status,
  onLoggedIn,
  onSkip,
}: LoginStepPlaceholderProps): ReactElement {
  const isLogged = status.loggedIn === true;

  // 已登录直接推进
  if (isLogged) {
    setTimeout(onLoggedIn, 0);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: "2rem",
          maxWidth: 720,
          width: "100%",
        }}
      >
        <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>第 2 步:登录 Claude</h1>
        <p style={{ margin: "0 0 1rem", color: "#6b7280" }}>
          M1 #21 范围内 LoginStep 占位;真实实现在 M1 #22(open-trad/opentrad#22) 落地。
        </p>

        <div
          style={{
            background: "#fef3c7",
            padding: "0.75rem 1rem",
            borderRadius: 6,
            fontSize: "0.9rem",
            color: "#92400e",
            marginBottom: "1rem",
          }}
        >
          {isLogged ? (
            <>已检测到已登录账号(自动跳转中…)</>
          ) : (
            <>
              CC 已安装但未登录。请在系统终端跑 <code>claude auth login</code>{" "}
              完成登录,然后回到这里继续。
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={onLoggedIn}
            disabled={!isLogged}
            style={{
              background: isLogged ? "#2563eb" : "#cbd5e1",
              color: "white",
              border: "none",
              padding: "0.6rem 1.2rem",
              borderRadius: 6,
              cursor: isLogged ? "pointer" : "not-allowed",
              fontSize: "0.95rem",
            }}
          >
            {isLogged ? "继续" : "等待登录…"}
          </button>
          <button
            type="button"
            onClick={onSkip}
            style={{
              background: "white",
              color: "#111827",
              border: "1px solid #e5e7eb",
              padding: "0.6rem 1.2rem",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: "0.95rem",
            }}
          >
            跳过引导
          </button>
        </div>
      </div>
    </div>
  );
}
