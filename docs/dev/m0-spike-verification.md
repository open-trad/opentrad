# M0 spike 手动验证步骤（发起人端到端）

对应重启计划 M0 验收：**干净环境纯 API key 完成一次含工具调用的对话并持久化回放；deny 生效且 audit_log 有记录**。全程在发起人真机执行。

## 0. 前置

```bash
pnpm install          # postinstall 会把 better-sqlite3/node-pty 编成 Electron ABI
pnpm dev              # 启动 desktop（electron-vite dev）
```

- 干净环境验证时可先移走 `~/.opentrad/opentrad.db`（新表 provider_profiles / credentials / agent_events 会自动建）。
- CC 未安装/未登录不影响本流程（agent 通道与 CC 通道完全平行）；onboarding 挡住的话按提示跳过或完成一次即可。

## 1. 填 DeepSeek / Anthropic key（Settings → Providers）

1. Header 右上齿轮 → 设置 → **Providers** tab。
2. 新增 DeepSeek profile：
   - 名称 `DeepSeek`；类型 `openai-compatible`；Base URL `https://api.deepseek.com/v1`；模型 `deepseek-chat`
   - 定价（可选，用于成本行）：输入价 `0.27`、输出价 `1.10`
   - API key：粘贴 `sk-…` → 保存
3. 同法新增 Anthropic profile（类型 `anthropic`，模型如 `claude-sonnet-4-5`，Base URL 留空）。
4. **验证密文落盘**：`sqlite3 ~/.opentrad/opentrad.db "select ref, length(ciphertext) from credentials;"` —— 只有密文 BLOB；`select * from provider_profiles;` 的 JSON 里只有 `credentialRef`，无任何 key 明文。
5. （可选负例）Linux 无 keyring 环境下保存 key 应直接报错拒存，不会明文落库。

## 2. 纯 API key 对话（不挂工具）

1. 中栏顶部切到 **Agent 对话（M0）**。
2. Profile 选 `DeepSeek`，MCP 命令留空 → 新建会话。
3. 发一条消息（如"用一句话介绍你自己"）：
   - 文本流式出现（MessageBubble）
   - 每步后出现灰色 usage 行 `tokens N↑ / M↓ · ≈$0.00xxxx`
   - 轮末出现 `✓ 本轮完成 · n 步 · 累计 $…`
4. 换 Anthropic profile 重复一次（新建会话）。

## 3. 挂 bb-browser MCP + 工具调用触发审批弹窗

1. 结束并新建会话：Profile 任选，MCP server 命令填 bb-browser 的 MCP 启动命令（以实际安装为准，如：
   `npx bb-browser-mcp`；bb-browser 需先在本机跑起来并登录目标站点）。
2. 新建会话成功后 header 显示 `工具 N 个`（N>0 = listTools 挂载成功；工具名带 `mcp:bb:` 前缀）。
3. 发起会用到工具的请求（如"用工具搜一下 usb hub 的商品列表"）：
   - 出现紫色工具调用卡片（参数可展开）
   - 非只读工具（无 readOnlyHint）默认 riskLevel=review → **弹出现有 Risk Gate 审批弹窗**
   - 点"允许一次" → 工具执行，结果卡片出现，loop 继续
4. 只读工具（readOnlyHint=true → safe）应直放不弹窗。

## 4. deny 生效

1. 再触发一次 review 工具调用，弹窗点**拒绝**：
   - 工具不执行；对话流出现红色 `⛔ Risk Gate 已拒绝` 卡片
   - loop 不崩溃：模型收到拒绝原因后改口继续回答（自愈）
2. 弹窗超时（5 分钟不理）同样按 deny 处理。

## 5. audit_log 可查

1. 设置 → **审计日志** tab：每次工具审批一条记录——safe 直放（自动/allow）、弹窗允许（用户/allow_once）、拒绝（用户/deny）、blocked（自动/deny, reason=blocked_policy）。
2. 或直接查库：`sqlite3 ~/.opentrad/opentrad.db "select tool_name, decision, automated, reason from audit_log order by id desc limit 10;"`

## 6. 事件持久化（回放数据旁证）

```bash
sqlite3 ~/.opentrad/opentrad.db \
  "select seq, type from agent_events where session_id='<sessionId>' order by seq;"
```

应看到完整事件序列：`agent_session_start → agent_text*/agent_tool_call/agent_tool_result → agent_usage → agent_session_result`。（回放 UI 在 M1 接 HistoryList；M0 以库中数据为准。）

## 已知边界（M0 接受）

- agent 会话不写旧 `sessions` 表，历史列表暂不显示 agent 会话
- 会话在 main 进程内存中，重启应用即失（checkpoint 恢复接线在 M1）
- 预算硬顶 UI 未暴露（IPC 已支持 budgetUsd，表单在 M1）
