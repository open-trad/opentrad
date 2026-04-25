// McpConfigWriter（M1 #26 / open-trad/opentrad#26，对应 03-architecture.md §4.4）。
//
// 每次 startTask 生成一份临时 mcp-config.json，让 CC 通过 stdio 拉起
// apps/mcp-server，并把 sessionId / IPC bridge socket 路径通过 env 注入。
// 任务结束后清理临时文件。
//
// 跨平台：os.tmpdir() 自动返回平台标准临时目录
//   - macOS: /var/folders/.../T/  (TMPDIR)
//   - Linux: /tmp/                (默认)
//   - Windows: C:\Users\<user>\AppData\Local\Temp\  (%TEMP%)
// 字符串路径 + JSON 序列化对反斜杠是安全的（JSON 自动转义），CC 接收 path
// argument 也跨平台 OK（已在 #25 端到端 smoke 验证 macOS 通；Windows 验证
// 在 #21 / #22 上路 onboarding 时一并触发，目前仅 unit 验证 + 三平台 CI typecheck）。

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillManifest } from "@opentrad/shared";
import { getIpcSocketPath } from "./db/paths";

export interface McpConfigWriterOptions {
  // mcp-server 可执行入口的绝对路径。process.execPath 是 Electron 二进制，
  // dev 时通过 tsx 跑 .ts 入口；打包后通过 Electron 内嵌 Node 跑 dist/index.js。
  // M1 #26 范围内只支持 dev（tsx 跑）；electron-builder 打包路径在 M1 #13 / #30。
  mcpServerCommand: string;
  mcpServerArgs: string[];
}

export class McpConfigWriter {
  constructor(private readonly opts: McpConfigWriterOptions) {}

  // 为某次 startTask 生成 mcp-config 临时文件。返回绝对路径，调用方传给
  // CC 的 --mcp-config 参数。
  generateForSession(sessionId: string, manifest: SkillManifest): string {
    const configPath = pathForSession(sessionId);
    mkdirSync(dirname(configPath), { recursive: true });

    const config = {
      mcpServers: {
        opentrad: {
          command: this.opts.mcpServerCommand,
          args: this.opts.mcpServerArgs,
          env: {
            OPENTRAD_IPC_SOCKET: getIpcSocketPath(),
            OPENTRAD_SESSION_ID: sessionId,
            // 把当前 PATH 透传，让 mcp-server 子进程能找到 node / 系统命令。
            // 不暴露 ~/.claude / 任何 token（红线）。
            PATH: process.env.PATH ?? "",
          },
        },
      },
      // 留个扩展位：`__opentrad__` 字段可用于把 manifest 元数据传给 mcp-server。
      // 当前未读，#11 / #28 RiskGate 接通时可能用到（如 skillId / riskLevel）。
      __opentrad__: {
        sessionId,
        skillId: manifest.id,
        skillVersion: manifest.version,
        skillRiskLevel: manifest.riskLevel,
      },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return configPath;
  }

  cleanup(sessionId: string): void {
    const configPath = pathForSession(sessionId);
    if (existsSync(configPath)) {
      try {
        unlinkSync(configPath);
      } catch {
        // 文件被占用 / 权限 → 静默；不阻塞 task 收尾
      }
    }
  }
}

function pathForSession(sessionId: string): string {
  return join(tmpdir(), `opentrad-${sessionId}.mcp.json`);
}
