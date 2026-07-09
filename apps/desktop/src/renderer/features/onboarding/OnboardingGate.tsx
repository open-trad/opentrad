// OnboardingGate（M1 #21 / open-trad/opentrad#21）：app 启动时根据 settings.onboarded
// 和 cc:status 决定是否走 onboarding 流程。
//
// 决策树（启动时一次性判断）：
// 1. settings.onboarded === true → 直接进 main App（用户曾完成或显式 onboarded）
// 2. cc:status 已 installed + loggedIn → 自动设 onboarded=true → 进 main App
//    （已 onboarded 但 settings 未持久化的情形,例如老用户从 W1 升级到 W2）
// 3. 否则 → onboarding 流程（InstallStep → LoginStep → 完成 set onboarded=true）
//
// 跳过引导路径（用户在任一步点"跳过"）：进 main App 但保持 onboarded=false,
// 下次启动再问。

import type { CCStatus } from "@opentrad/shared";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { InstallStep } from "./InstallStep";
import { LoginStep } from "./LoginStep";

const ONBOARDED_KEY = "onboarded";

type GateState =
  | { kind: "loading" }
  | { kind: "install" }
  | { kind: "login"; status: CCStatus }
  | { kind: "main" };

export interface OnboardingGateProps {
  // onboarded 后渲染的主界面（M0 hello world / 后续 #29 ChatLayout）
  children: ReactNode;
}

export function OnboardingGate({ children }: OnboardingGateProps): ReactElement {
  const [state, setState] = useState<GateState>({ kind: "loading" });

  // 启动时决策：onboarded? cc:status?
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const onboarded = await window.api.settings.get(ONBOARDED_KEY);
        if (cancelled) return;
        if (onboarded === true) {
          setState({ kind: "main" });
          return;
        }
        // 未持久化 onboarded → 看 cc:status 兜底
        const status = await window.api.cc.status();
        if (cancelled) return;
        if (status.installed && status.loggedIn === true) {
          // 已 ready,自动设 onboarded=true 跳过 onboarding
          await window.api.settings.set(ONBOARDED_KEY, true);
          if (!cancelled) setState({ kind: "main" });
          return;
        }
        if (status.installed) {
          setState({ kind: "login", status });
        } else {
          setState({ kind: "install" });
        }
      } catch (err) {
        console.error("[onboarding-gate] decision failed", err);
        if (!cancelled) setState({ kind: "main" }); // 出错时不阻塞,进 main
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#6b7280",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        加载中…
      </div>
    );
  }

  if (state.kind === "install") {
    return (
      <InstallStep
        onInstalled={(status) => {
          // 装好但未登录 → 进 LoginStep;已登录 → 直接 set onboarded=true 进 main
          if (status.loggedIn === true) {
            void window.api.settings.set(ONBOARDED_KEY, true);
            setState({ kind: "main" });
          } else {
            setState({ kind: "login", status });
          }
        }}
        onSkip={() => {
          // 跳过引导:本会话进 main,但 onboarded 保持 false（下次启动再问）
          setState({ kind: "main" });
        }}
      />
    );
  }

  if (state.kind === "login") {
    return (
      <LoginStep
        status={state.status}
        onLoggedIn={() => {
          void window.api.settings.set(ONBOARDED_KEY, true);
          setState({ kind: "main" });
        }}
        onSkip={() => setState({ kind: "main" })}
      />
    );
  }

  return <>{children}</>;
}
