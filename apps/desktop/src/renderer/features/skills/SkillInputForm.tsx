// SkillInputForm(M1 #24):根据 manifest.inputs 动态生成表单。
//
// 5 种 input 类型(@opentrad/shared SkillInputSchema enum):
// - text:单行 input
// - textarea:多行 textarea
// - url:type=url 单行 input(浏览器自带 URL 校验)
// - select:dropdown,options 必填
// - file:**M1 暂不支持**(留 follow-up,需要 IPC channel `shell:select-file` +
//   主进程 dialog.showOpenDialog + 1MB 限制 + base64 读)
//
// 必填校验:required 字段未填时禁用提交按钮 + 字段红框。
// 提交时 onSubmit({inputs}) 由父组件处理(SkillWorkArea)。

import type { SkillInput, SkillManifest } from "@opentrad/shared";
import { type ReactElement, useEffect, useState } from "react";

export interface SkillInputFormProps {
  skill: SkillManifest;
  onSubmit: (inputs: Record<string, unknown>) => void;
  // 提交按钮文案(默认"发送")
  submitLabel?: string;
  // 提交按钮 disabled override(任务进行中等)
  submitting?: boolean;
}

export function SkillInputForm({
  skill,
  onSubmit,
  submitLabel = "发送",
  submitting = false,
}: SkillInputFormProps): ReactElement {
  // 表单状态:每个 input.name → 当前值;default 初始化
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const input of skill.inputs) {
      initial[input.name] = input.default ?? "";
    }
    return initial;
  });
  // 已 touched 的字段(展示红框前提:用户操作过 + 仍空)
  const [touched, setTouched] = useState<Set<string>>(new Set());

  // skill 切换时重置表单。只 watch skill.id(稳定标识);skill.inputs 数组引用每次
  // 渲染会变,加进 deps 会导致无意义重置。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上方注释
  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const input of skill.inputs) {
      initial[input.name] = input.default ?? "";
    }
    setValues(initial);
    setTouched(new Set());
  }, [skill.id]);

  const setValue = (name: string, value: string): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };
  const markTouched = (name: string): void => {
    setTouched((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  };

  // 提交可用性:所有 required 字段非空
  const allRequiredFilled = skill.inputs.every(
    (input) => !input.required || (values[input.name] ?? "").trim().length > 0,
  );
  const canSubmit = allRequiredFilled && !submitting;

  const handleSubmit = (): void => {
    if (!canSubmit) return;
    // 提交前所有字段标 touched(高亮缺失项给最后机会)
    setTouched(new Set(skill.inputs.map((i) => i.name)));
    if (!allRequiredFilled) return;
    onSubmit({ ...values });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
      style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      {skill.inputs.map((input) => (
        <FieldRow
          key={input.name}
          input={input}
          value={values[input.name] ?? ""}
          touched={touched.has(input.name)}
          onChange={(v) => setValue(input.name, v)}
          onBlur={() => markTouched(input.name)}
        />
      ))}

      <div>
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            background: canSubmit ? "#2563eb" : "#cbd5e1",
            color: "white",
            border: "none",
            padding: "0.6rem 1.4rem",
            borderRadius: 6,
            cursor: canSubmit ? "pointer" : "not-allowed",
            fontSize: "0.95rem",
          }}
        >
          {submitting ? "进行中…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

interface FieldRowProps {
  input: SkillInput;
  value: string;
  touched: boolean;
  onChange: (v: string) => void;
  onBlur: () => void;
}

function FieldRow({ input, value, touched, onChange, onBlur }: FieldRowProps): ReactElement {
  const isMissingRequired = input.required && touched && value.trim().length === 0;
  const borderColor = isMissingRequired ? "#dc2626" : "#e5e7eb";

  const labelEl = (
    <label
      htmlFor={`field-${input.name}`}
      style={{
        display: "block",
        fontSize: "0.85rem",
        fontWeight: 500,
        color: "#374151",
        marginBottom: "0.35rem",
      }}
    >
      {input.label}
      {input.required ? <span style={{ color: "#dc2626", marginLeft: "0.25rem" }}>*</span> : null}
    </label>
  );

  const fieldStyle: React.CSSProperties = {
    width: "100%",
    padding: "0.5rem 0.7rem",
    fontSize: "0.9rem",
    border: `1px solid ${borderColor}`,
    borderRadius: 6,
    boxSizing: "border-box",
    fontFamily: "inherit",
    background: "white",
  };

  let fieldEl: ReactElement;
  switch (input.type) {
    case "textarea":
      fieldEl = (
        <textarea
          id={`field-${input.name}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={input.placeholder}
          rows={4}
          style={{ ...fieldStyle, resize: "vertical", minHeight: 90 }}
        />
      );
      break;
    case "select":
      fieldEl = (
        <select
          id={`field-${input.name}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          style={fieldStyle}
        >
          <option value="">{input.placeholder ?? "请选择"}</option>
          {(input.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
      break;
    case "url":
      fieldEl = (
        <input
          id={`field-${input.name}`}
          type="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={input.placeholder ?? "https://..."}
          style={fieldStyle}
        />
      );
      break;
    case "file":
      // M1 暂不支持(需要 main 进程 dialog.showOpenDialog + 1MB 限制 + base64;
      // 留 follow-up,fixture-skill 不触发此分支)
      fieldEl = (
        <div
          style={{
            ...fieldStyle,
            color: "#92400e",
            background: "#fef3c7",
            cursor: "not-allowed",
          }}
        >
          file 类型 M1 暂不支持(留 #29 / follow-up)
        </div>
      );
      break;
    default:
      fieldEl = (
        <input
          id={`field-${input.name}`}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={input.placeholder}
          style={fieldStyle}
        />
      );
  }

  return (
    <div>
      {labelEl}
      {fieldEl}
      {isMissingRequired ? (
        <div style={{ fontSize: "0.75rem", color: "#dc2626", marginTop: "0.25rem" }}>
          此项为必填
        </div>
      ) : null}
    </div>
  );
}
