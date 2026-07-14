import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionHistoryStatus } from "../src/renderer/features/shell/AppShell";

describe("Agent session history status", () => {
  it("shows a retryable failure instead of the empty-history message", () => {
    const html = renderToStaticMarkup(
      createElement(SessionHistoryStatus, {
        loading: false,
        error: "database unavailable",
        isEmpty: true,
        onRetry: () => {},
      }),
    );

    expect(html).toContain("历史加载失败");
    expect(html).toContain("重试");
    expect(html).not.toContain("暂无历史");
  });

  it("does not advertise empty history while the first load is pending", () => {
    const html = renderToStaticMarkup(
      createElement(SessionHistoryStatus, {
        loading: true,
        error: null,
        isEmpty: true,
        onRetry: () => {},
      }),
    );

    expect(html).toContain("正在加载历史");
    expect(html).not.toContain("暂无历史");
  });
});
