// RiskGate middleware(M1 #28 阶段 2)。
//
// 把 mcp-server CallToolRequest handler 内 inline 的 risk-gate 拦截抽出来,改走
// IPC bridge `risk-gate.request` RPC(由 desktop 主进程的真实 RiskGate.check 处理)。
//
// **wire schema 0 改动**(发起人 #25 hello 帧约束):RiskGateRequest 仍是
// { skillId, toolName, params, riskLevel, businessAction? },本 middleware
// 传 skillId="" 占位(desktop 端用 ctx.sessionId 重查真 skillId,优先级高于 params)。
//
// graceful degrade(D-M1-5 deny by default):
// - bridge offline:bridge.riskGateRequest 内部已实现(返 deny + reason='ipc bridge offline')
// - bridge call throw:本层捕获,返 deny + reason='middleware_error'(不让 CC 卡死)
//
// 调用顺序由 mcp-server index.ts 控制:
// 1. tool.riskLevel === 'blocked' → 直接拒(本 middleware 处理)
// 2. tool.riskLevel === 'review' → bridge.riskGateRequest → 用 decision 决定
// 3. tool.riskLevel === 'safe' → bypass middleware,直接 execute
//
// 注:safe + businessAction 的升级判断在 desktop 端 RiskGate 内做(stopBeforeList 命中
// toolName);mcp-server 不感知 stopBefore,这是设计(让 RiskGate 单点决定)。

import type { IpcBridgeClient } from "../ipc-bridge";
import type { OpenTradTool } from "../tools";

export interface MiddlewareDecision {
  allowed: boolean;
  reason?: string;
}

export interface RunRiskGateOptions {
  bridge: IpcBridgeClient;
  tool: OpenTradTool;
  toolArgs: unknown;
  sessionId: string;
}

export async function runRiskGate(opts: RunRiskGateOptions): Promise<MiddlewareDecision> {
  const { bridge, tool, toolArgs } = opts;

  // 1. blocked 直接拒(local short-circuit,不走 bridge)
  if (tool.riskLevel === "blocked") {
    return { allowed: false, reason: `tool ${tool.name} is blocked by risk policy` };
  }

  // 2. safe bypass(safe + businessAction 升级判断在 desktop RiskGate 端,
  //    mcp-server 不感知 stopBefore;safe tool 不应过 RiskGate 增加 RTT)
  if (tool.riskLevel === "safe") {
    return { allowed: true };
  }

  // 3. review 走 bridge(desktop RiskGate.check)
  try {
    const decision = await bridge.riskGateRequest({
      // skillId 占位:desktop 端 resolveSkillContext 用 ctx.sessionId 重查真值
      skillId: "",
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      params: toolArgs,
    });

    if (
      decision.decision === "allow" ||
      decision.decision === "allow_once" ||
      decision.decision === "allow_always"
    ) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: decision.reason ?? `user denied ${tool.name}`,
    };
  } catch (err) {
    // graceful degrade:bridge.riskGateRequest 抛异常 → deny by default
    const message = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      reason: `risk-gate middleware error: ${message}`,
    };
  }
}
