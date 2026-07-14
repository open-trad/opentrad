import type { RiskGateConfirmPayload } from "@opentrad/shared";
import type { ReactElement } from "react";

export function HermesTrustedCodeNotice({
  payload,
}: {
  payload: RiskGateConfirmPayload;
}): ReactElement | null {
  if (payload.category !== "hermes-native" || !hasPluginName(payload.params)) return null;
  return (
    <p style={noticeStyle}>
      Hermes 插件会以受信代码运行，并继承当前执行环境的权限；请只允许你信任的插件。
    </p>
  );
}

function hasPluginName(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const pluginName = Reflect.get(params, "pluginName");
  return typeof pluginName === "string" && pluginName.length > 0;
}

const noticeStyle: React.CSSProperties = {
  marginTop: "0.8rem",
  marginBottom: 0,
  border: "1px solid #fbbf24",
  borderRadius: 6,
  background: "#fffbeb",
  color: "#92400e",
  padding: "0.65rem 0.75rem",
  fontSize: "0.8rem",
  lineHeight: 1.45,
};
