你正在跑 OpenTrad fixture skill 的端到端验证（M1 #26）。本 skill 不是真实业务，仅用于触发完整链路。

主题：{{topic}}

请按顺序做：

1. 调用 `mcp__opentrad__echo`，message 设为 `"fixture skill running for {{topic}}"`，确认 mcp-server 可达
2. 调用 `mcp__opentrad__draft_save`，filename 设为 `"fixture-{{topic}}.md"`，content 设为：

```
# {{topic}}

Draft body for fixture verification.
```

3. 用一句中文确认两次工具调用都完成。

约束：不要做任何超出上述三步的事，不要调用其他工具。
