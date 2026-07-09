// RiskGateOverlay(M1 #28 阶段 3):全局 RiskGate 弹窗容器。
//
// 挂载在 App.tsx 最外层,subscribe IPC channel risk-gate:confirm,根据 payload
// 决定渲染 RiskGateDialog(工具级)or BusinessActionCard(业务级,businessAction 非空)。
// 用户决策后通过 risk-gate:response IPC 发回 main 进程。
//
// 队列:同时多个 prompt 时按 FIFO 处理(显示第一个,resolve 后弹下一个)。M1 实测
// fixture-skill 一次只触发 1 个 review tool,实际 ≥1 仅在 M2 多 skill 并发时遇到。

import type { RiskGateConfirmPayload } from "@opentrad/shared";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { BusinessActionCard } from "./BusinessActionCard";
import { RiskGateDialog } from "./RiskGateDialog";

type DecisionKind = "allow_once" | "allow_always" | "deny" | "request_edit";

export function RiskGateOverlay(): ReactElement | null {
  const [queue, setQueue] = useState<RiskGateConfirmPayload[]>([]);

  useEffect(() => {
    const off = window.api.riskGate.onConfirm((payload) => {
      setQueue((prev) => [...prev, payload]);
    });
    return off;
  }, []);

  const current = queue[0];

  const decide = useCallback(
    async (kind: DecisionKind): Promise<void> => {
      if (!current) return;
      try {
        await window.api.riskGate.sendResponse({
          requestId: current.requestId,
          kind,
        });
      } catch (err) {
        // 失败也要 pop 队列,否则永久卡;main 端 5min timeout 会兜底
        console.error("[risk-gate-overlay] sendResponse failed", err);
      } finally {
        setQueue((prev) => prev.slice(1));
      }
    },
    [current],
  );

  if (!current) return null;

  // 业务级 vs 工具级:businessAction 非空走 BusinessActionCard
  if (current.businessAction) {
    return <BusinessActionCard payload={current} onDecide={(k) => void decide(k)} />;
  }
  return <RiskGateDialog payload={current} onDecide={(k) => void decide(k)} />;
}
