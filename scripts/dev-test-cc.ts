// 端到端冒烟脚本：Issue #5 验收用，也作为回归测试基础（M0 骨架可跑的最小 demo）。
// 跑法：pnpm dev:test-cc
//
// 流程：detectInstallation → getAuthStatus → startTask("Say OK") → print events → cleanup
// 跑完后发起人应在 shell 里自行 `ps aux | grep claude` 验证无残留。

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCManager, redactEmail } from "@opentrad/cc-adapter";

async function main(): Promise<void> {
  const manager = new CCManager();

  // --- Step 1: detectInstallation ---
  console.log("\n[1/4] detectInstallation");
  const detected = await manager.detectInstallation();
  console.log(JSON.stringify(detected, null, 2));
  if (!detected.installed) {
    console.error("Claude Code not installed, abort.");
    process.exit(1);
  }

  // --- Step 2: getAuthStatus ---
  console.log("\n[2/4] getAuthStatus");
  const auth = await manager.getAuthStatus();
  console.log(
    JSON.stringify(
      {
        loggedIn: auth.loggedIn,
        method: auth.method,
        email: auth.email ? redactEmail(auth.email) : undefined,
        organization: auth.organization ? "<redacted>" : undefined,
      },
      null,
      2,
    ),
  );
  if (!auth.loggedIn) {
    console.error("Claude not logged in, abort.");
    process.exit(1);
  }

  // --- Step 3: startTask + consume events ---
  console.log("\n[3/4] startTask");
  const tmpDir = await mkdtemp(join(tmpdir(), "opentrad-dev-"));
  const mcpConfigPath = join(tmpDir, "mcp-config.json");
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

  const sessionId = randomUUID();
  console.log(`  sessionId=${sessionId}`);

  const handle = await manager.startTask({
    sessionId,
    prompt: "Say OK in Chinese",
    mcpConfigPath,
    allowedTools: [],
    model: "haiku",
  });
  console.log(`  pid=${handle.pid}`);

  let eventCount = 0;
  for await (const event of handle.events) {
    eventCount++;
    const base = `  event#${eventCount} type=${event.type}`;
    if (event.type === "system") {
      console.log(`${base} cc_version=${event.data.claudeCodeVersion}`);
    } else if (event.type === "assistant_text") {
      console.log(
        `${base} seq=${event.seq} isLast=${event.isLast} text=${JSON.stringify(event.text)}`,
      );
    } else if (event.type === "assistant_thinking") {
      console.log(
        `${base} seq=${event.seq} isLast=${event.isLast} thinking_chars=${event.thinking.length}`,
      );
    } else if (event.type === "assistant_tool_use") {
      console.log(`${base} seq=${event.seq} toolUseId=${event.toolUseId} name=${event.name}`);
    } else if (event.type === "result") {
      console.log(
        `${base} subtype=${event.subtype} durationMs=${event.data.durationMs} totalCostUsd=${event.data.totalCostUsd}`,
      );
    } else if (event.type === "rate_limit_event") {
      console.log(`${base} rateLimitType=${event.rateLimitInfo.rateLimitType}`);
    } else {
      console.log(base);
    }
  }

  const result = await handle.result();
  console.log(`\n  [final result] status=${result.status} exitCode=${result.exitCode}`);

  // --- Step 4: cleanup ---
  console.log("\n[4/4] cleanup");
  await manager.cleanup();
  console.log(`  activeTasks after cleanup: ${manager.activeTasks.size}`);

  // 清理临时 mcp-config 目录
  await rm(tmpDir, { recursive: true, force: true });

  console.log("\nDone. Run `ps aux | grep '[c]laude'` to verify no residual processes.");
}

main().catch((err) => {
  console.error("\n[fatal]", err);
  process.exit(1);
});
