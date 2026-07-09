// bb-browser 连接器：把预置站点注册为 ToolHost 工具。
//
// 每个已启用站点 → 一个工具 "site:<id>"，执行时 spawn bb-browser CLI。
// tool-host 的审批钩子在执行前把关（站点均只读 → safe，一般直放）。

import type { ToolDescriptor, ToolExecutionResult, ToolHost } from "@opentrad/tool-host";
import { type BbRunResult, buildSiteArgs, type RunnerOptions, runBbBrowser } from "./runner";
import { BB_SITES, type BbSite, getBbSite } from "./sites";

export * from "./preflight";
export * from "./runner";
export * from "./sites";

// 站点 → JSON Schema（tool inputSchema，透传给模型）
function siteInputSchema(site: BbSite): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of site.args) {
    const prop: Record<string, unknown> = { type: arg.type, description: arg.description };
    if (arg.enum) prop.enum = arg.enum;
    properties[arg.key] = prop;
    if (arg.required) required.push(arg.key);
  }
  return { type: "object", properties, required };
}

export function siteToolDescriptor(site: BbSite): ToolDescriptor {
  return {
    name: `site:${site.id}`,
    description: `${site.name} — ${site.description}`,
    inputSchema: siteInputSchema(site),
    source: "connector",
    riskLevel: site.toolRisk,
  };
}

// 把一组已启用站点注册进 ToolHost。opts 供测试注入 spawn。
// 返回注册的工具名，便于后续按需卸载。
export function registerBbSites(
  host: ToolHost,
  enabledSiteIds: string[],
  opts: RunnerOptions = {},
): string[] {
  const registered: string[] = [];
  for (const id of enabledSiteIds) {
    const site = getBbSite(id);
    if (!site) continue;
    const descriptor = siteToolDescriptor(site);
    host.register(descriptor, async (input): Promise<ToolExecutionResult> => {
      const result = await runSite(site, (input ?? {}) as Record<string, unknown>, opts);
      if (!result.ok) {
        // 三层错误信息合成一段可读文本喂回模型（模型可据 hint/action 决定下一步或告知用户）
        const parts = [result.error];
        if (result.hint) parts.push(`提示：${result.hint}`);
        if (result.action) parts.push(`可尝试：${result.action}`);
        return { output: parts.filter(Boolean).join("\n"), isError: true };
      }
      return { output: result.data };
    });
    registered.push(descriptor.name);
  }
  return registered;
}

// 执行单个站点搜索（供工具 handler 与直接调用复用）
export async function runSite(
  site: BbSite,
  input: Record<string, unknown>,
  opts: RunnerOptions = {},
): Promise<BbRunResult> {
  const argsOrErr = buildSiteArgs(site, input);
  if (!Array.isArray(argsOrErr)) return argsOrErr;
  return runBbBrowser(argsOrErr, site.timeoutMs, opts);
}

export { BB_SITES, getBbSite };
