// 内置模型目录（PROVIDER_CATALOG）。
//
// 数据日期：2026-07-09。定价随厂商政策变动，此处仅供成本估算展示，不作结算依据。
// UI 用它做"选厂商 → 选型号 → 填 API key"三步配置；kind/baseUrl 影响功能（必须准），
// pricing 只影响成本估算显示（近似即可，注明置信度）。
//
// 数据来源与置信度：
// - Anthropic：官方 docs 定价页实测（高）
// - DeepSeek：官方 api-docs 定价页实测（高）
// - 通义千问：阿里云 Model Studio 国际站定价页实测（高，含分档取代表值）
// - OpenAI：官方定价页 403，取第三方聚合站近似值（中，标注需核实）
// - Moonshot Kimi：官方页仅列型号未给数字，取近似值（中，标注需核实）

import type { ProviderKind } from "./types";

export interface CatalogModel {
  // 精确 API model id（传给 provider 的字符串）
  id: string;
  displayName: string;
  // 一句话定位
  note: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export interface CatalogProvider {
  // 稳定标识（非 API 值，仅用于 UI 与 profile 生成）
  id: string;
  displayName: string;
  kind: ProviderKind;
  // openai-compatible 必填的 OpenAI 兼容端点
  baseUrl?: string;
  // 去哪申请 key（UI 提示）
  credentialHint: string;
  // 定价置信度：high=官方实测，approx=第三方近似需核实
  pricingConfidence: "high" | "approx";
  models: CatalogModel[];
}

// 目录数据版本（UI/迁移可据此判断是否需刷新）
export const CATALOG_DATE = "2026-07-09";

export const PROVIDER_CATALOG: CatalogProvider[] = [
  {
    id: "anthropic",
    displayName: "Anthropic Claude",
    kind: "anthropic",
    credentialHint: "在 console.anthropic.com 创建 API key",
    pricingConfidence: "high",
    models: [
      {
        id: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        note: "最强推理，复杂任务/长链路首选",
        inputPerMTokUsd: 5,
        outputPerMTokUsd: 25,
      },
      {
        id: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        note: "生产主力，性价比均衡（限时引导价至 2026-08-31）",
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 10,
      },
      {
        id: "claude-haiku-4-5-20251001",
        displayName: "Claude Haiku 4.5",
        note: "快而省，简单任务/高频调用",
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 5,
      },
      {
        id: "claude-fable-5",
        displayName: "Claude Fable 5",
        note: "旗舰，最高质量",
        inputPerMTokUsd: 10,
        outputPerMTokUsd: 50,
      },
    ],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    kind: "openai",
    credentialHint: "在 platform.openai.com 创建 API key",
    pricingConfidence: "approx",
    models: [
      {
        id: "gpt-5.6",
        displayName: "GPT-5.6",
        note: "旗舰（定价近似，以官方为准）",
        inputPerMTokUsd: 5,
        outputPerMTokUsd: 15,
      },
      {
        id: "gpt-5.6-mini",
        displayName: "GPT-5.6 mini",
        note: "性价比档（定价近似，以官方为准）",
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 4,
      },
    ],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek 深度求索",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    credentialHint: "在 platform.deepseek.com 创建 API key",
    pricingConfidence: "high",
    models: [
      {
        id: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        note: "低价高速，选品批量调用首选",
        inputPerMTokUsd: 0.14,
        outputPerMTokUsd: 0.28,
      },
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        note: "更强推理，1M 上下文",
        inputPerMTokUsd: 0.435,
        outputPerMTokUsd: 0.87,
      },
    ],
  },
  {
    id: "qwen",
    displayName: "通义千问 Qwen",
    kind: "openai-compatible",
    // 国际站（新加坡）OpenAI 兼容端点；国内站为 https://dashscope.aliyuncs.com/compatible-mode/v1
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    credentialHint: "在阿里云百炼 Model Studio 开通并创建 API key",
    pricingConfidence: "high",
    models: [
      {
        id: "qwen3.7-max",
        displayName: "Qwen 3.7 Max",
        note: "旗舰，最强能力",
        inputPerMTokUsd: 2.5,
        outputPerMTokUsd: 7.5,
      },
      {
        id: "qwen-plus",
        displayName: "Qwen Plus",
        note: "均衡主力（分档计价，取代表值）",
        inputPerMTokUsd: 0.4,
        outputPerMTokUsd: 1.2,
      },
      {
        id: "qwen3.5-flash",
        displayName: "Qwen 3.5 Flash",
        note: "极低价，高频调用",
        inputPerMTokUsd: 0.1,
        outputPerMTokUsd: 0.4,
      },
    ],
  },
  {
    id: "moonshot",
    displayName: "Moonshot 月之暗面 Kimi",
    kind: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    credentialHint: "在 platform.moonshot.ai 创建 API key",
    pricingConfidence: "approx",
    models: [
      {
        id: "kimi-k2.6",
        displayName: "Kimi K2.6",
        note: "长上下文强项（定价近似，以官方为准）",
        inputPerMTokUsd: 0.6,
        outputPerMTokUsd: 2.5,
      },
      {
        id: "kimi-k2.7-code",
        displayName: "Kimi K2.7 Code",
        note: "代码/工具调用向（定价近似，以官方为准）",
        inputPerMTokUsd: 0.6,
        outputPerMTokUsd: 2.5,
      },
    ],
  },
];

// 目录首项（UI 默认选中）。目录常量非空，此处提供类型安全的默认值。
export const DEFAULT_CATALOG_PROVIDER: CatalogProvider = PROVIDER_CATALOG[0] as CatalogProvider;

// 按 id 取 provider，找不到回落首项（UI 用，避免 undefined 判空）
export function getCatalogProvider(providerId: string): CatalogProvider {
  return PROVIDER_CATALOG.find((p) => p.id === providerId) ?? DEFAULT_CATALOG_PROVIDER;
}

// 在指定 provider 里按 id 取 model，找不到回落该 provider 首个型号
export function getCatalogModel(provider: CatalogProvider, modelId: string): CatalogModel {
  return provider.models.find((m) => m.id === modelId) ?? (provider.models[0] as CatalogModel);
}

// 从目录条目构造一个 ProviderProfile 的可持久化字段（不含 credentialRef——由调用方注入）。
// UI 选定 provider+model 后调用，得到 profile 骨架，再补 id/displayName/credentialRef 落库。
export function catalogModelToProfileFields(
  providerId: string,
  modelId: string,
): {
  kind: ProviderKind;
  baseUrl?: string;
  model: string;
  pricing: { inputPerMTokUsd: number; outputPerMTokUsd: number };
} {
  const provider = PROVIDER_CATALOG.find((p) => p.id === providerId);
  if (!provider) throw new Error(`unknown provider in catalog: ${providerId}`);
  const model = provider.models.find((m) => m.id === modelId);
  if (!model) throw new Error(`unknown model in catalog: ${providerId}/${modelId}`);
  return {
    kind: provider.kind,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    model: model.id,
    pricing: {
      inputPerMTokUsd: model.inputPerMTokUsd,
      outputPerMTokUsd: model.outputPerMTokUsd,
    },
  };
}
