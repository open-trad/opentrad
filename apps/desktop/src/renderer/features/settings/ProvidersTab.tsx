// ProvidersTab（M0 spike）：Settings 里的 Provider Profile 简单表单。
//
// - 列表：现有 profiles + 删除（删除时级联清凭证，见 agent store）
// - 新增：displayName / kind / baseUrl（openai-compatible 必填）/ model / 定价（可选）/ API key
//   API key 经 agent:credentials:set 进 main safeStorage 加密落库；本组件不回显、不留内存副本
// - credentialRef 约定：apikey:<profileId>

import type { ProviderProfile } from "@opentrad/model-providers";
import { Trash2 } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { useAgentStore } from "../../stores/agent";

type Kind = "anthropic" | "openai" | "openai-compatible";

const KIND_PRESETS: Record<Kind, { baseUrl?: string; model: string }> = {
  anthropic: { model: "claude-sonnet-4-5" },
  openai: { model: "gpt-5.2" },
  "openai-compatible": { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
};

export function ProvidersTab(): ReactElement {
  const profiles = useAgentStore((s) => s.profiles);
  const profilesLoaded = useAgentStore((s) => s.profilesLoaded);
  const loadProfiles = useAgentStore((s) => s.loadProfiles);
  const saveProfile = useAgentStore((s) => s.saveProfile);
  const deleteProfile = useAgentStore((s) => s.deleteProfile);

  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<Kind>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState(KIND_PRESETS["openai-compatible"].baseUrl ?? "");
  const [model, setModel] = useState(KIND_PRESETS["openai-compatible"].model);
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!profilesLoaded) void loadProfiles();
  }, [profilesLoaded, loadProfiles]);

  const handleKindChange = (next: Kind): void => {
    setKind(next);
    setBaseUrl(KIND_PRESETS[next].baseUrl ?? "");
    setModel(KIND_PRESETS[next].model);
  };

  const handleSave = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    if (!displayName.trim() || !model.trim()) {
      setError("名称与模型必填");
      return;
    }
    if (kind === "openai-compatible" && !baseUrl.trim()) {
      setError("openai-compatible 必须填 Base URL");
      return;
    }
    if (!apiKey.trim()) {
      setError("API key 必填（存入系统 keychain，不明文落盘）");
      return;
    }
    const id = crypto.randomUUID();
    const pricing =
      inputPrice.trim() && outputPrice.trim()
        ? {
            inputPerMTokUsd: Number(inputPrice),
            outputPerMTokUsd: Number(outputPrice),
          }
        : null;
    if (
      pricing &&
      (Number.isNaN(pricing.inputPerMTokUsd) || Number.isNaN(pricing.outputPerMTokUsd))
    ) {
      setError("定价必须是数字（每百万 token 美元）");
      return;
    }
    const profile: ProviderProfile = {
      id,
      displayName: displayName.trim(),
      kind,
      baseUrl: baseUrl.trim() || undefined,
      model: model.trim(),
      credentialRef: `apikey:${id}`,
      pricing,
    };
    setSaving(true);
    try {
      await saveProfile(profile, apiKey);
      setDisplayName("");
      setApiKey("");
      setInputPrice("");
      setOutputPrice("");
      setNotice(`已保存 profile「${profile.displayName}」`);
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

      <h3 style={{ ...sectionTitleStyle, marginTop: "1.5rem" }}>新增 Profile</h3>
      <div style={formGridStyle}>
        <label style={labelStyle}>
          名称
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="如 DeepSeek 选品"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          类型
          <select
            value={kind}
            onChange={(e) => handleKindChange(e.target.value as Kind)}
            style={inputStyle}
          >
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="openai-compatible">openai-compatible（DeepSeek/通义/Moonshot）</option>
          </select>
        </label>
        <label style={labelStyle}>
          Base URL{kind === "openai-compatible" ? "（必填）" : "（可选）"}
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          模型
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          输入价 $/MTok（可选）
          <input
            type="text"
            value={inputPrice}
            onChange={(e) => setInputPrice(e.target.value)}
            placeholder="0.27"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          输出价 $/MTok（可选）
          <input
            type="text"
            value={outputPrice}
            onChange={(e) => setOutputPrice(e.target.value)}
            placeholder="1.10"
            style={inputStyle}
          />
        </label>
        <label style={{ ...labelStyle, gridColumn: "1 / -1" }}>
          API key（存系统 keychain / safeStorage，保存后不可回看）
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
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving}
        style={{ ...primaryBtnStyle, opacity: saving ? 0.6 : 1 }}
      >
        {saving ? "保存中…" : "保存 Profile"}
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
