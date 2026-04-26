// snapshotToText 测试:验证 LLM 友好 plaintext 序列化格式。
// extractDomSnapshot 本身需要 browser context (document/window),
// 单测不跑该函数(覆盖在 BrowserService.readPageText 集成测里 mock 它的返回值)。

import { describe, expect, it } from "vitest";
import { type DomSnapshot, snapshotToText } from "../src/dom-snapshot";

const SAMPLE: DomSnapshot = {
  title: "Test Page",
  url: "https://test.example/path?q=1",
  headings: [
    { level: 1, text: "Welcome" },
    { level: 2, text: "Section A" },
    { level: 3, text: "Sub A.1" },
  ],
  visibleText: "Body content here.",
  links: [
    { href: "https://test.example/about", text: "About" },
    { href: "https://test.example/docs", text: "Docs" },
  ],
};

describe("snapshotToText", () => {
  it("包含 URL / Title / Headings / Visible text / Links", () => {
    const text = snapshotToText(SAMPLE);
    expect(text).toContain("URL: https://test.example/path?q=1");
    expect(text).toContain("Title: Test Page");
    expect(text).toContain("# Welcome");
    expect(text).toContain("## Section A");
    expect(text).toContain("### Sub A.1");
    expect(text).toContain("Body content here.");
    expect(text).toContain("https://test.example/about");
    expect(text).toContain("https://test.example/docs");
  });

  it("空 headings / 空 links 不输出对应段落", () => {
    const text = snapshotToText({
      ...SAMPLE,
      headings: [],
      links: [],
      visibleText: "only body",
    });
    expect(text).not.toContain("Headings:");
    expect(text).not.toContain("Links (");
    expect(text).toContain("only body");
  });

  it("无文本 link 显示 (no text)", () => {
    const text = snapshotToText({
      ...SAMPLE,
      links: [{ href: "https://x.example/", text: "" }],
    });
    expect(text).toContain("[(no text)] https://x.example/");
  });

  it("headings 截到 30 个", () => {
    const many: DomSnapshot["headings"] = Array.from({ length: 50 }, (_, i) => ({
      level: 1,
      text: `H${i}`,
    }));
    const text = snapshotToText({ ...SAMPLE, headings: many });
    expect(text).toContain("# H29");
    expect(text).not.toContain("# H30");
  });

  it("输出大小约束:典型 case ≤5KB", () => {
    const text = snapshotToText(SAMPLE);
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(5 * 1024);
  });
});
