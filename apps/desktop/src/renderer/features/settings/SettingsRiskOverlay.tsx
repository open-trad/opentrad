// SettingsRiskOverlay(M1 #28 阶段 4):/settings/risk 子页 modal-style。
//
// **D9-1 决策**:M1 不引入 router 框架(react-router 等大依赖),用全屏 modal 等价
// 实现 "settings 子页"。M2 真做 settings 框架时把 modal 改路由,接口契约不变。
//
// 两个 Tab:
// - Rules:risk_rules 表所有规则,每条带"删除"按钮
// - Audit:audit_log 全表分页(50/页),按 timestamp DESC
//
// 触发:Header 齿轮图标 → setOpen(true)。关闭:右上角 ✕ / 按 ESC / 点击 overlay 背景。

import type { AuditLogRow, RiskRuleRow } from "@opentrad/shared";
import { Settings, Trash2, X } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

const PAGE_SIZE = 50;

export interface SettingsRiskOverlayProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "rules" | "audit";

export function SettingsRiskOverlay({
  open,
  onClose,
}: SettingsRiskOverlayProps): ReactElement | null {
  const [tab, setTab] = useState<Tab>("rules");

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
            <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Risk 设置</h2>
          </div>
          <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div style={tabBarStyle}>
          <TabButton active={tab === "rules"} onClick={() => setTab("rules")}>
            规则({/* count loaded after */})
          </TabButton>
          <TabButton active={tab === "audit"} onClick={() => setTab("audit")}>
            审计日志
          </TabButton>
        </div>

        <div style={tabContentStyle}>{tab === "rules" ? <RulesTab /> : <AuditTab />}</div>
      </div>
    </div>
  );
}

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
