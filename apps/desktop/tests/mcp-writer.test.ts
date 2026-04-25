// McpConfigWriter 测试。验证 generateForSession 写出合法 JSON + 含 sessionId
// + IPC socket env，cleanup 正确删文件。

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillManifest } from "@opentrad/shared";
import { describe, expect, it } from "vitest";
import { McpConfigWriter } from "../src/main/services/mcp-writer";

const SAMPLE_MANIFEST: SkillManifest = {
  id: "fixture-skill",
  title: "Fixture",
  version: "0.1.0",
  description: "test",
  category: "communication",
  riskLevel: "draft_only",
  allowedTools: ["mcp__opentrad__echo"],
  disallowedTools: undefined,
  stopBefore: undefined,
  inputs: [],
  outputs: ["draft"],
  promptTemplate: "prompt.md",
};

describe("McpConfigWriter", () => {
  it("generateForSession 写合法 JSON 含 sessionId / IPC env / mcpServers.opentrad", () => {
    const writer = new McpConfigWriter({
      mcpServerCommand: "/usr/bin/tsx",
      mcpServerArgs: ["/path/to/mcp-server/src/index.ts"],
    });
    const sessionId = "test-session-aaaa";
    const path = writer.generateForSession(sessionId, SAMPLE_MANIFEST);

    expect(path).toBe(join(tmpdir(), `opentrad-${sessionId}.mcp.json`));
    expect(existsSync(path)).toBe(true);

    const config = JSON.parse(readFileSync(path, "utf-8"));
    expect(config.mcpServers.opentrad.command).toBe("/usr/bin/tsx");
    expect(config.mcpServers.opentrad.args).toEqual(["/path/to/mcp-server/src/index.ts"]);
    expect(config.mcpServers.opentrad.env.OPENTRAD_SESSION_ID).toBe(sessionId);
    expect(config.mcpServers.opentrad.env.OPENTRAD_IPC_SOCKET).toBeDefined();
    // PATH 透传，子进程能找 node / 系统命令
    expect(config.mcpServers.opentrad.env.PATH).toBeDefined();
    // 不暴露任何凭证/token
    expect(config.mcpServers.opentrad.env).not.toHaveProperty("HOME");

    // __opentrad__ 扩展元数据（M1 #28 RiskGate 可能用到）
    expect(config.__opentrad__.sessionId).toBe(sessionId);
    expect(config.__opentrad__.skillId).toBe("fixture-skill");
    expect(config.__opentrad__.skillRiskLevel).toBe("draft_only");

    unlinkSync(path); // 清理
  });

  it("cleanup 删文件，幂等（已删时不抛）", () => {
    const writer = new McpConfigWriter({
      mcpServerCommand: "/usr/bin/tsx",
      mcpServerArgs: ["/x"],
    });
    const sessionId = "cleanup-test";
    const path = writer.generateForSession(sessionId, SAMPLE_MANIFEST);
    expect(existsSync(path)).toBe(true);

    writer.cleanup(sessionId);
    expect(existsSync(path)).toBe(false);

    // 二次 cleanup 不抛
    expect(() => writer.cleanup(sessionId)).not.toThrow();
  });

  it("跨平台 tmpdir 路径（不依赖 platform）", () => {
    const writer = new McpConfigWriter({
      mcpServerCommand: "x",
      mcpServerArgs: [],
    });
    const path = writer.generateForSession("xplat-test", SAMPLE_MANIFEST);
    // tmpdir() 返回平台标准路径，路径分隔符匹配 OS
    expect(path.startsWith(tmpdir())).toBe(true);
    writer.cleanup("xplat-test");
  });
});
