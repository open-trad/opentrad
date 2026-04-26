// RiskGate interface + MockRiskGate(M1 #27 落地点)。
//
// 设计意图:tool execute 前根据 tool.riskLevel 决定:
// - safe   → 直接执行
// - review → 调 RiskGate.requestApproval,用户确认后才执行(真 RiskGate 弹窗在 M1 #28)
// - blocked → 直接拒
//
// **本文件 M1 #27 提供 MockRiskGate(allow 所有)**。
// **M1 #28 (#28) 落地真 RiskGate**:走 IPC bridge 调 desktop main 进程,弹窗等待用户决定。
// 那时 RiskGate interface 不变,把 MockRiskGate 替换为 IpcRiskGate(走 bridge)即可。
//
// 不放 packages/shared:#28 时只需 mcp-server 端的具体 impl 替换,接口不必跨包共享。

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  // tool 调用参数,用于在弹窗里给用户看(如 url、target email 等)
  params: unknown;
  // 业务级动作描述(M2 增强:skill 可声明 "我即将做 X");M1 此字段可为空
  businessAction?: string;
}

export interface ApprovalResult {
  allowed: boolean;
  // 用户拒绝时的原因(可选,用于 audit log)
  reason?: string;
  // 用户是否选择"以后都允许该 skill 的此 tool"(M2 用,M1 mock 永远 false)
  rememberDecision?: boolean;
}

export interface RiskGate {
  requestApproval(req: ApprovalRequest): Promise<ApprovalResult>;
}

// M1 #27 mock:允许所有,记一行 stderr 方便诊断。
// **不要在 M1 #28 之后还用本类**:真 RiskGate 落地后切到 IpcRiskGate。
export class MockRiskGate implements RiskGate {
  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    process.stderr.write(
      `[opentrad-mcp] MockRiskGate auto-allow: tool=${req.toolName} session=${req.sessionId}\n`,
    );
    return { allowed: true };
  }
}
