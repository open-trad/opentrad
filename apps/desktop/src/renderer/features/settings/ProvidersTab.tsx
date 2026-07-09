// ProvidersTab（M0 spike）：Settings 里的 Provider Profile 简单表单。
//
// - 列表：现有 profiles + 删除（删除时级联清凭证，见 agent store）
// - 新增：displayName / kind / baseUrl（openai-compatible 必填）/ model / 定价（可选）/ API key
//   API key 经 agent:credentials:set 进 main safeStorage 加密落库；本组件不回显、不留内存副本
// - credentialRef 约定：apikey:<profileId>

import {
  catalogModelToProfileFields,
  DEFAULT_CATALOG_PROVIDER,
  getCatalogModel,
  getCatalogProvider,
  PROVIDER_CATALOG,
  type ProviderProfile,
} from "@opentrad/model-providers";
import { Trash2 } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { useAgentStore } from "../../stores/agent";

export function ProvidersTab(): ReactElement {
  const profiles = useAgentStore((s) => s.profiles);
  const profilesLoaded = useAgentStore((s) => s.profilesLoaded);
  const loadProfiles = useAgentStore((s) => s.loadProfiles);
  const saveProfile = useAgentStore((s) => s.saveProfile);
  const deleteProfile = useAgentStore((s) => s.deleteProfile);

  // 目录驱动：选厂商 → 选型号（自动带出 kind/baseUrl/model/定价）→ 填 key
  const [providerId, setProviderId] = useState(DEFAULT_CATALOG_PROVIDER.id);
  const [modelId, setModelId] = useState(DEFAULT_CATALOG_PROVIDER.models[0]?.id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!profilesLoaded) void loadProfiles();
  }, [profilesLoaded, loadProfiles]);

  const provider = getCatalogProvider(providerId);
  const model = getCatalogModel(provider, modelId);

  const handleProviderChange = (next: string): void => {
    setProviderId(next);
    setModelId(getCatalogProvider(next).models[0]?.id ?? "");
  };

  const handleSave = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    if (!apiKey.trim()) {
      setError("API key 必填（存入系统 keychain，不明文落盘）");
      return;
    }
    const id = crypto.randomUUID();
    const fields = catalogModelToProfileFields(provider.id, model.id);
    const profile: ProviderProfile = {
      id,
      displayName: `${provider.displayName} · ${model.displayName}`,
      kind: fields.kind,
      baseUrl: fields.baseUrl,
      model: fields.model,
      credentialRef: `apikey:${id}`,
      pricing: fields.pricing,
    };
    setSaving(true);
    try {
      await saveProfile(profile, apiKey);
      setApiKey("");
      setNotice(`已保存「${profile.displayName}」`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    setError(null);
    try {
      await deleteProfile(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <h3 style={sectionTitleStyle}>已有 Profiles</h3>
      {profiles.length === 0 ? (
        <div style={emptyStyle}>暂无 profile，用下方表单添加。</div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: "1px solid #e5e7eb", background: "#f8fafc" }}>
              <th style={thStyle}>名称</th>
              <th style={thStyle}>类型</th>
              <th style={thStyle}>模型</th>
              <th style={thStyle}>定价 ($/MTok)</th>
              <th style={{ ...thStyle, width: 50 }} />
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={tdStyle}>{p.displayName}</td>
                <td style={tdStyle}>
                  <code style={codeStyle}>{p.kind}</code>
                </td>
                <td style={tdStyle}>
                  <code style={codeStyle}>{p.model}</code>
                </td>
                <td style={tdStyle}>
                  {p.pricing ? `${p.pricing.inputPerMTokUsd} / ${p.pricing.outputPerMTokUsd}` : "—"}
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    onClick={() => void handleDelete(p.id)}
                    style={iconBtnStyle}
                    aria-label="删除 profile"
                    title="删除（凭证一并清除）"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ ...sectionTitleStyle, marginTop: "1.5rem" }}>接入模型</h3>
      <div style={formGridStyle}>
        <label style={labelStyle}>
          厂商
          <select
            value={providerId}
            onChange={(e) => handleProviderChange(e.target.value)}
            style={inputStyle}
          >
            {PROVIDER_CATALOG.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          型号
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={inputStyle}>
            {provider.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} — {m.note}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...labelStyle, gridColumn: "1 / -1" }}>
          API key（{provider.credentialHint}；存系统 keychain，保存后不可回看）
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            style={inputStyle}
            autoComplete="off"
          />
        </label>
      </div>
      <div style={{ fontSize: "0.78rem", color: "#9ca3af", margin: "0.4rem 0 0.8rem" }}>
        定价约 ${model.inputPerMTokUsd} / ${model.outputPerMTokUsd} 每百万 token（输入/输出，
        {provider.pricingConfidence === "high" ? "官方" : "估算"}，仅供参考）
        {provider.baseUrl ? ` · 端点 ${provider.baseUrl}` : ""}
      </div>
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving}
        style={{ ...primaryBtnStyle, opacity: saving ? 0.6 : 1 }}
      >
        {saving ? "保存中…" : "保存并接入"}
      </button>
      {error ? <p style={{ color: "#b91c1c", fontSize: "0.8rem" }}>{error}</p> : null}
      {notice ? <p style={{ color: "#166534", fontSize: "0.8rem" }}>{notice}</p> : null}
    </div>
  );
}

// ----- styles -----

const sectionTitleStyle: React.CSSProperties = {
  margin: "0 0 0.6rem",
  fontSize: "0.9rem",
  color: "#111827",
};

const emptyStyle: React.CSSProperties = {
  padding: "1rem",
  color: "#9ca3af",
  fontSize: "0.85rem",
  background: "#f8fafc",
  borderRadius: 8,
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.45rem 0.6rem",
  fontWeight: 500,
  color: "#374151",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const tdStyle: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  verticalAlign: "top",
};

const codeStyle: React.CSSProperties = {
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: "0.78rem",
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

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0.75rem 1rem",
  marginBottom: "0.9rem",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.78rem",
  color: "#374151",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: "0.25rem",
  padding: "0.4rem 0.55rem",
  fontSize: "0.85rem",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "white",
  fontFamily: "inherit",
  boxSizing: "border-box",
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
};
