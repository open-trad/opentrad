// RiskGate UI 端参数脱敏(M1 #28 阶段 3)。
//
// 测三种脱敏:邮箱 / homedir 路径 / URL 内嵌 user:pass。

import { describe, expect, it } from "vitest";
import {
  paramsToDisplayString,
  redactString,
  redactValue,
} from "../src/renderer/features/risk-gate/redact";

describe("redactString", () => {
  it("邮箱:保留首字符 + ***@domain", () => {
    expect(redactString("Contact: alice@example.com")).toBe("Contact: a***@example.com");
    expect(redactString("send to bob.smith+tag@gmail.com")).toBe("send to b***@gmail.com");
  });

  it("macOS homedir 路径:替换用户名为 <REDACTED>", () => {
    expect(redactString("/Users/john/Desktop/secret.txt")).toBe(
      "/<HOME>/<REDACTED>/Desktop/secret.txt",
    );
  });

  it("Linux homedir 路径:同上", () => {
    expect(redactString("/home/jane/projects/x")).toBe("/<HOME>/<REDACTED>/projects/x");
  });

  it("URL 内嵌 user:pass:替换为 <REDACTED>:<REDACTED>@", () => {
    expect(redactString("https://alice:secret123@github.com/repo")).toBe(
      "https://<REDACTED>:<REDACTED>@github.com/repo",
    );
  });

  it("无敏感信息原样返回", () => {
    expect(redactString("hello world")).toBe("hello world");
    expect(redactString("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it("混合多种敏感:同时脱敏", () => {
    const input = "user alice@x.com at /Users/alice/notes";
    expect(redactString(input)).toBe("user a***@x.com at /<HOME>/<REDACTED>/notes");
  });
});

describe("redactValue", () => {
  it("递归脱敏 object", () => {
    const input = {
      to: "bob@example.com",
      attachment: "/Users/bob/file.pdf",
      meta: { from: "carol@y.com" },
    };
    expect(redactValue(input)).toEqual({
      to: "b***@example.com",
      attachment: "/<HOME>/<REDACTED>/file.pdf",
      meta: { from: "c***@y.com" },
    });
  });

  it("递归脱敏 array", () => {
    expect(redactValue(["alice@x.com", "bob@y.com"])).toEqual(["a***@x.com", "b***@y.com"]);
  });

  it("非字符串原样返回(number / boolean / null)", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBeNull();
  });
});

describe("paramsToDisplayString", () => {
  it("脱敏后 pretty JSON", () => {
    const out = paramsToDisplayString({ url: "https://x", to: "alice@y.com" });
    expect(out).toContain("a***@y.com");
    expect(out).toContain('"url"');
  });

  it("循环引用 graceful 返回 fallback", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(paramsToDisplayString(cyclic)).toBe("(无法序列化)");
  });
});
