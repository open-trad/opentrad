// bb-browser 站点目录（预置）。
//
// 每个站点 = 一个 bb-browser site 适配器。目录预置是因为 `bb-browser site list`
// 在浏览器/daemon 未就绪时会报错——UI 插件页必须能离线渲染卡片，不依赖运行时探测。
// 运行时可用 site list 结果去 merge/校准（标记哪些实际已安装），但目录本身是这份常量。
//
// 数据来源：主会话 2026-07-09 在发起人机器实机核实 + bb-sites 社区适配器仓 @meta。
// 发起人本地 ~/.bb-browser/sites/ 已有 1688/taobao/pdd/amazon 私有适配器（非占位）。

import type { RiskLevel } from "./risk-gate";

// 站点参数定义（映射到 bb-browser site 命令的 --key value）
export interface SiteArg {
  key: string;
  type: "string" | "number";
  required: boolean;
  description: string;
  example?: string;
  enum?: string[];
}

export interface BbSite {
  // 稳定 id（连接器工具名 = "site:<id>"）
  id: string;
  name: string;
  emoji: string;
  // bb-browser site 命令：`bb-browser site <command> --json ...`
  command: string;
  // 目标域名（登录/风控归属）
  domain: string;
  // 需要用户在受管浏览器登录才能拿到完整数据
  requiresLogin: boolean;
  // 打开登录页的 URL（requiresLogin 时用）；null = 无需登录
  loginUrl: string | null;
  // 反爬/失败风险：low/medium/high → 影响超时与 UI 提示
  risk: "low" | "medium" | "high";
  riskNote?: string;
  // 全部为只读搜索/翻译 → risk-gate 层面 safe
  toolRisk: RiskLevel;
  timeoutMs: number;
  args: SiteArg[];
  // 一句话用途（UI 卡片描述）
  description: string;
}

export const BB_SITES: BbSite[] = [
  {
    id: "1688",
    name: "1688 货源搜索",
    emoji: "🏭",
    command: "1688/search-products",
    domain: "s.1688.com",
    requiresLogin: true,
    loginUrl: "https://login.1688.com",
    risk: "high",
    riskNote: "淘系风控强，失败时引导在浏览器打开 1688 过验证",
    toolRisk: "safe",
    timeoutMs: 60000,
    description: "按关键词搜 1688 货源：标题/批发价/MOQ/供应商/地区",
    args: [
      {
        key: "keyword",
        type: "string",
        required: true,
        description: "搜索关键词",
        example: "蓝牙耳机",
      },
    ],
  },
  {
    id: "taobao",
    name: "淘宝商品搜索",
    emoji: "🛍️",
    command: "taobao/search-products",
    domain: "taobao.com",
    requiresLogin: true,
    loginUrl: "https://login.taobao.com",
    risk: "high",
    riskNote: "anti-bot 强，失败时引导在浏览器打开 s.taobao.com 过验证",
    toolRisk: "safe",
    timeoutMs: 60000,
    description: "按关键词搜淘宝商品：标题/价格/销量/店铺/天猫标",
    args: [
      {
        key: "keyword",
        type: "string",
        required: true,
        description: "搜索关键词",
        example: "蓝牙耳机",
      },
      { key: "priceMin", type: "number", required: false, description: "最低价（元）" },
      { key: "priceMax", type: "number", required: false, description: "最高价（元）" },
      {
        key: "sort",
        type: "string",
        required: false,
        description: "排序",
        enum: ["sales", "price", "rating"],
      },
    ],
  },
  {
    id: "pdd",
    name: "拼多多商品搜索",
    emoji: "🧧",
    command: "pdd/search-products",
    domain: "mobile.yangkeduo.com",
    requiresLogin: true,
    loginUrl: "https://mobile.yangkeduo.com",
    risk: "high",
    riskNote: "风控强，建议已登录",
    toolRisk: "safe",
    timeoutMs: 60000,
    description: "按关键词搜拼多多商品：标题/价格/销量",
    args: [
      {
        key: "keyword",
        type: "string",
        required: true,
        description: "搜索关键词",
        example: "数据线",
      },
    ],
  },
  {
    id: "amazon",
    name: "Amazon 商品搜索",
    emoji: "📦",
    command: "amazon/search-products",
    domain: "www.amazon.com",
    requiresLogin: false,
    loginUrl: null,
    risk: "high",
    riskNote: "Akamai 反爬，captcha 时需人工在浏览器完成一次搜索",
    toolRisk: "safe",
    timeoutMs: 60000,
    description: "按关键词搜 Amazon：标题/价格/评分/ASIN",
    args: [
      {
        key: "keyword",
        type: "string",
        required: true,
        description: "搜索关键词",
        example: "laptop stand",
      },
      {
        key: "department",
        type: "string",
        required: false,
        description: "分类别名，如 electronics",
      },
    ],
  },
  {
    id: "aliexpress",
    name: "速卖通商品搜索",
    emoji: "🌏",
    command: "aliexpress/search-product",
    domain: "aliexpress.com",
    requiresLogin: false,
    loginUrl: "https://www.aliexpress.com",
    risk: "high",
    riskNote: "强反爬，建议已登录 + 美/欧 IP",
    toolRisk: "safe",
    timeoutMs: 60000,
    description: "按关键词搜速卖通商品（英文效果更好）：标题/价格/销量",
    args: [
      {
        key: "keyword",
        type: "string",
        required: true,
        description: "搜索关键词（英文）",
        example: "smart watch",
      },
      { key: "priceMin", type: "number", required: false, description: "最低价（美元）" },
      { key: "priceMax", type: "number", required: false, description: "最高价（美元）" },
    ],
  },
  {
    id: "ebay",
    name: "eBay 商品搜索",
    emoji: "🏷️",
    command: "ebay/find-a-product",
    domain: "www.ebay.com",
    requiresLogin: false,
    loginUrl: null,
    risk: "medium",
    riskNote: "Akamai 标签，反爬弱于 Amazon",
    toolRisk: "safe",
    timeoutMs: 45000,
    description: "按关键词搜 eBay 商品：标题/价格/卖家",
    args: [
      {
        key: "keyword",
        type: "string",
        required: true,
        description: "搜索关键词",
        example: "iphone 15",
      },
    ],
  },
  {
    id: "jd",
    name: "京东商品搜索",
    emoji: "🐶",
    command: "jd/search-products",
    domain: "search.jd.com",
    requiresLogin: true,
    loginUrl: "https://passport.jd.com",
    risk: "medium",
    toolRisk: "safe",
    timeoutMs: 45000,
    description: "按关键词搜京东商品：标题/价格/销量/评价",
    args: [
      {
        key: "keyword",
        type: "string",
        required: true,
        description: "搜索关键词",
        example: "机械键盘",
      },
      { key: "priceMin", type: "number", required: false, description: "最低价（元）" },
      { key: "priceMax", type: "number", required: false, description: "最高价（元）" },
    ],
  },
  {
    id: "smzdm",
    name: "什么值得买好价",
    emoji: "💰",
    command: "smzdm/search",
    domain: "search.smzdm.com",
    requiresLogin: false,
    loginUrl: null,
    risk: "low",
    toolRisk: "safe",
    timeoutMs: 30000,
    description: "搜什么值得买好价情报：标题/价格/推荐理由",
    args: [
      {
        key: "keyword",
        type: "string",
        required: true,
        description: "搜索关键词",
        example: "耳机",
      },
    ],
  },
  {
    id: "google",
    name: "Google 搜索",
    emoji: "🔎",
    command: "google/search",
    domain: "www.google.com",
    requiresLogin: false,
    loginUrl: null,
    risk: "low",
    toolRisk: "safe",
    timeoutMs: 30000,
    description: "Google 网页搜索：供应商背调/竞品调研",
    args: [
      {
        key: "query",
        type: "string",
        required: true,
        description: "搜索词",
        example: "LED strip supplier",
      },
    ],
  },
  {
    id: "baidu",
    name: "百度搜索",
    emoji: "🐾",
    command: "baidu/search",
    domain: "www.baidu.com",
    requiresLogin: false,
    loginUrl: null,
    risk: "low",
    toolRisk: "safe",
    timeoutMs: 30000,
    description: "百度网页搜索：国内信息/供应商调研",
    args: [{ key: "query", type: "string", required: true, description: "搜索词" }],
  },
  {
    id: "youdao",
    name: "有道翻译",
    emoji: "🈶",
    command: "youdao/translate",
    domain: "dict.youdao.com",
    requiresLogin: false,
    loginUrl: null,
    risk: "low",
    toolRisk: "safe",
    timeoutMs: 30000,
    description: "中英互译：listing 本地化辅助",
    args: [
      {
        key: "query",
        type: "string",
        required: true,
        description: "要翻译的词或句",
        example: "hello",
      },
    ],
  },
];

export function getBbSite(id: string): BbSite | undefined {
  return BB_SITES.find((s) => s.id === id);
}
