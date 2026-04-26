// SettingsOverlay(M1 #29 12b 重构):多 tab 设置 modal-style。
// 历史:M1 #28 阶段 4 是 SettingsRiskOverlay(只 risk),M1 #29 升级为 5 tabs。
//
// **D9-1 决策**:M1 不引入 router 框架(react-router 等大依赖),用全屏 modal 等价
// 实现 "settings 子页"。M2 真做 settings 框架时把 modal 改路由,接口契约不变。
//
// 5 Tabs:
// - General:语言切换(M1 显示但 i18n 完整支持留 follow-up)+ 主题(M2)
// - CC:CC 版本 / 登录状态 / 安装路径 / "重新检测"按钮
// - Rules:risk_rules 表所有规则,每条带"删除"按钮
// - Audit:audit_log 全表分页(50/页),按 timestamp DESC
// - About:版本号 / GitHub / AGPL-3.0
//
// 触发:Header 齿轮图标 → setOpen(true)。关闭:右上角 ✕ / 按 ESC / 点击 overlay 背景。

import type { AuditLogRow, CCStatus, RiskRuleRow } from "@opentrad/shared";
import { Settings, Trash2, X } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

const PAGE_SIZE = 50;
const APP_VERSION = "0.0.0"; // M1 hardcoded;M2 从 package.json runtime 读
const REPO_URL = "https://github.com/open-trad/opentrad";

export interface SettingsOverlayProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "general" | "cc" | "rules" | "audit" | "about";

export function SettingsOverlay({ open, onClose }: SettingsOverlayProps): ReactElement | null {
  const [tab, setTab] = useState<Tab>("general");

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: overlay 背景点击关闭是常规 modal 模式,内部 modal 内容仍可交互
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div style={modalStyle}>
        <header style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Settings size={18} aria-hidden="true" />
            <h2 style={{ margin: 0, fontSize: "1.05rem" }}>设置</h2>
          </div>
          <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div style={tabBarStyle}>
          <TabButton active={tab === "general"} onClick={() => setTab("general")}>
            通用
          </TabButton>
          <TabButton active={tab === "cc"} onClick={() => setTab("cc")}>
            Claude Code
          </TabButton>
          <TabButton active={tab === "rules"} onClick={() => setTab("rules")}>
            规则
          </TabButton>
          <TabButton active={tab === "audit"} onClick={() => setTab("audit")}>
            审计日志
          </TabButton>
          <TabButton active={tab === "about"} onClick={() => setTab("about")}>
            关于
          </TabButton>
        </div>

        <div style={tabContentStyle}>
          {tab === "general" && <GeneralTab />}
          {tab === "cc" && <CcTab />}
          {tab === "rules" && <RulesTab />}
          {tab === "audit" && <AuditTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}

// ----- General Tab -----
// M1:语言切换 UI 占位(完整 i18n 全 UI 文案 follow-up issue);
// 主题 UI 占位 disabled(M2 dark mode)。

function GeneralTab(): ReactElement {
  const [lang, setLang] = useState<"zh-CN" | "en">("zh-CN");

  // M1 实际不做 i18n.changeLanguage(全 UI 文案改 t() 是 follow-up issue,
  // 工作量超 12b 一个 commit 范围)。本 select 仅展示设计意图,选 en 后无视觉变化。
  // M2 完整 i18n 落地后此 onChange 真实生效。
  return (
    <div>
      <SettingItem label="语言" hint="界面文案语言(完整 i18n 在 follow-up issue 落地)">
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value as "zh-CN" | "en")}
          style={selectStyle}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </SettingItem>

      <SettingItem label="主题" hint="M2 dark mode 落地后启用">
        <select disabled style={{ ...selectStyle, opacity: 0.5, cursor: "not-allowed" }}>
          <option>跟随系统(M2)</option>
        </select>
      </SettingItem>
    </div>
  );
}

// ----- CC Tab -----

function CcTab(): ReactElement {
  const [status, setStatus] = useState<CCStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const s = await window.api.cc.status();
      setStatus(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div>
      <SettingItem label="安装状态">
        <span>
          {loading ? "检测中…" : status?.installed ? `✓ 已安装 v${status.version}` : "× 未安装"}
        </span>
      </SettingItem>
      <SettingItem label="登录状态">
        <span>
          {!status?.installed
            ? "—"
            : status.loggedIn
              ? `✓ ${status.email ?? "(已登录)"} (${status.authMethod === "subscription" ? "订阅" : "API"})`
              : "× 未登录"}
        </span>
      </SettingItem>
      <SettingItem
        label="安装路径"
        hint="M1 仅显示 binary 名;实际路径由 PATH 解析(M2 显示 which 结果)"
      >
        <code style={codeStyle}>claude</code>
      </SettingItem>
      <button type="button" onClick={() => void reload()} style={primaryBtnStyle}>
        重新检测
      </button>
    </div>
  );
}

// ----- About Tab -----

function AboutTab(): ReactElement {
  const handleOpenRepo = async (): Promise<void> => {
    try {
      await window.api.shell.openExternal({ url: REPO_URL });
    } catch (err) {
      console.error("[about] openExternal failed", err);
    }
  };

  return (
    <div>
      <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.1rem", color: "#111827" }}>OpenTrad</h3>
      <p style={{ margin: "0 0 1rem", color: "#6b7280", fontSize: "0.9rem" }}>
        基于 Claude Code 的外贸 AI 工作台
      </p>

      <SettingItem label="版本">
        <code style={codeStyle}>v{APP_VERSION}</code>
      </SettingItem>
      <SettingItem label="GitHub">
        <button
          type="button"
          onClick={() => void handleOpenRepo()}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: "#2563eb",
            textDecoration: "underline",
            cursor: "pointer",
            fontSize: "0.9rem",
            fontFamily: "inherit",
          }}
        >
          {REPO_URL.replace("https://", "")}
        </button>
      </SettingItem>
      <SettingItem label="License">
        <span style={{ fontSize: "0.85rem", color: "#374151" }}>AGPL-3.0</span>
      </SettingItem>
    </div>
  );
}

// 通用 SettingItem
function SettingItem({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <span
          style={{
            fontSize: "0.85rem",
            color: "#374151",
            fontWeight: 500,
          }}
        >
          {label}
        </span>
        <div>{children}</div>
      </div>
      {hint ? (
        <p style={{ margin: "0.3rem 0 0", fontSize: "0.75rem", color: "#94a3b8" }}>{hint}</p>
      ) : null}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  fontSize: "0.85rem",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "white",
  fontFamily: "inherit",
  minWidth: 160,
};

const primaryBtnStyle: React.CSSProperties = {
  background: "#2563eb",
  color: "white",
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
  fontFamily: "inherit",
  marginTop: "0.5rem",
};

// ----- Rules Tab -----

function RulesTab(): ReactElement {
  const [rules, setRules] = useState<RiskRuleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.api.riskGate.listRules();
      setRules(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleDelete = async (id: number): Promise<void> => {
    try {
      await window.api.riskGate.deleteRule({ id });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading && rules.length === 0) {
    return <div style={emptyStyle}>加载中…</div>;
  }
  if (error) {
    return <div style={{ ...emptyStyle, color: "#b91c1c" }}>加载失败:{error}</div>;
  }
  if (rules.length === 0) {
    return (
      <div style={emptyStyle}>暂无规则。在 RiskGate 弹窗点"以后都允许"会自动添加规则到此处。</div>
    );
  }

  return (
    <table style={tableStyle}>
      <thead>
        <tr style={tableHeaderRowStyle}>
          <th style={tableThStyle}>Skill</th>
          <th style={tableThStyle}>工具 / 业务动作</th>
          <th style={tableThStyle}>决策</th>
          <th style={tableThStyle}>创建时间</th>
          <th style={{ ...tableThStyle, width: 60 }} />
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => (
          <tr key={rule.id} style={tableRowStyle}>
            <td style={tableTdStyle}>
              <code style={codeStyle}>{rule.skillId ?? "—"}</code>
            </td>
            <td style={tableTdStyle}>
              {rule.businessAction ? (
                <span style={{ color: "#7f1d1d" }}>业务:{rule.businessAction}</span>
              ) : (
                <code style={codeStyle}>{rule.toolName ?? "—"}</code>
              )}
            </td>
            <td style={tableTdStyle}>
              <span
                style={{
                  color: rule.decision === "allow" ? "#166534" : "#b91c1c",
                  fontWeight: 500,
                }}
              >
                {rule.decision === "allow" ? "允许" : "拒绝"}
              </span>
            </td>
            <td style={{ ...tableTdStyle, color: "#6b7280", fontSize: "0.8rem" }}>
              {new Date(rule.createdAt).toLocaleString()}
            </td>
            <td style={tableTdStyle}>
              <button
                type="button"
                onClick={() => void handleDelete(rule.id)}
                style={iconBtnStyle}
                aria-label="删除规则"
                title="删除"
              >
                <Trash2 size={14} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ----- Audit Tab -----

function AuditTab(): ReactElement {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (newOffset: number): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.api.riskGate.queryAuditLog({
        offset: newOffset,
        limit: PAGE_SIZE,
      });
      setRows(result.rows);
      setTotal(result.total);
      setOffset(newOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload(0);
  }, [reload]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (error) {
    return <div style={{ ...emptyStyle, color: "#b91c1c" }}>加载失败:{error}</div>;
  }
  if (total === 0 && !loading) {
    return <div style={emptyStyle}>暂无审计日志。RiskGate 触发后会写入此处。</div>;
  }

  return (
    <div>
      <table style={tableStyle}>
        <thead>
          <tr style={tableHeaderRowStyle}>
            <th style={tableThStyle}>时间</th>
            <th style={tableThStyle}>Skill / Tool</th>
            <th style={tableThStyle}>决策</th>
            <th style={tableThStyle}>触发</th>
            <th style={tableThStyle}>原因</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={tableRowStyle}>
              <td style={{ ...tableTdStyle, color: "#6b7280", fontSize: "0.8rem" }}>
                {new Date(row.timestamp).toLocaleString()}
              </td>
              <td style={tableTdStyle}>
                <div style={{ fontSize: "0.8rem" }}>
                  <code style={codeStyle}>{row.skillId ?? "—"}</code>
                </div>
                <div style={{ fontSize: "0.85rem", marginTop: "0.2rem" }}>
                  {row.businessAction ? (
                    <span style={{ color: "#7f1d1d" }}>业务:{row.businessAction}</span>
                  ) : (
                    <code style={codeStyle}>{row.toolName}</code>
                  )}
                </div>
              </td>
              <td style={tableTdStyle}>
                <DecisionBadge decision={row.decision} />
              </td>
              <td style={{ ...tableTdStyle, color: "#6b7280", fontSize: "0.8rem" }}>
                {row.automated ? "自动" : "用户"}
              </td>
              <td style={{ ...tableTdStyle, color: "#6b7280", fontSize: "0.75rem" }}>
                {row.reason ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={paginationStyle}>
        <span style={{ color: "#6b7280", fontSize: "0.8rem" }}>
          第 {page} / {totalPages} 页 (共 {total} 条)
        </span>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            disabled={offset === 0 || loading}
            onClick={() => void reload(Math.max(0, offset - PAGE_SIZE))}
            style={pageBtnStyle}
          >
            上一页
          </button>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= total || loading}
            onClick={() => void reload(offset + PAGE_SIZE)}
            style={pageBtnStyle}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: string }): ReactElement {
  const isAllow = decision.startsWith("allow");
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.15rem 0.45rem",
        borderRadius: 4,
        fontSize: "0.75rem",
        background: isAllow ? "#dcfce7" : "#fee2e2",
        color: isAllow ? "#166534" : "#b91c1c",
        fontWeight: 500,
      }}
    >
      {decision}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: "0.5rem 0.85rem",
        fontSize: "0.85rem",
        cursor: "pointer",
        borderBottom: active ? "2px solid #2563eb" : "2px solid transparent",
        color: active ? "#2563eb" : "#6b7280",
        fontFamily: "inherit",
        fontWeight: active ? 500 : 400,
      }}
    >
      {children}
    </button>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "2rem",
  zIndex: 9000, // 略低于 RiskGate 弹窗(9999)
};

const modalStyle: React.CSSProperties = {
  background: "white",
  borderRadius: 10,
  maxWidth: 900,
  width: "100%",
  maxHeight: "85vh",
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 20px 50px rgba(0, 0, 0, 0.25)",
  fontFamily: "system-ui, -apple-system, sans-serif",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "1rem 1.5rem",
  borderBottom: "1px solid #e5e7eb",
  color: "#111827",
};

const closeBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: "0.25rem",
  color: "#6b7280",
  borderRadius: 4,
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  padding: "0 1rem",
  borderBottom: "1px solid #e5e7eb",
  flexShrink: 0,
};

const tabContentStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "1rem 1.5rem",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const tableHeaderRowStyle: React.CSSProperties = {
  borderBottom: "1px solid #e5e7eb",
  background: "#f8fafc",
};

const tableThStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  fontWeight: 500,
  color: "#374151",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const tableRowStyle: React.CSSProperties = {
  borderBottom: "1px solid #f3f4f6",
};

const tableTdStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  verticalAlign: "top",
};

const codeStyle: React.CSSProperties = {
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: "0.8rem",
  background: "#f3f4f6",
  padding: "0.1rem 0.35rem",
  borderRadius: 3,
};

const iconBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: "0.25rem",
  color: "#dc2626",
  borderRadius: 4,
};

const paginationStyle: React.CSSProperties = {
  marginTop: "1rem",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const pageBtnStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #e5e7eb",
  padding: "0.4rem 0.8rem",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.8rem",
  color: "#374151",
  fontFamily: "inherit",
};

const emptyStyle: React.CSSProperties = {
  padding: "2rem",
  textAlign: "center",
  color: "#9ca3af",
  fontSize: "0.9rem",
};
