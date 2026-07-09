// SkillLoader 测试:loadFromDirectory 主路径 + per-skill try/catch 不阻塞。
// 5 个 manifest 中 1 个故意损坏的验收用 tmpdir 临时构造,test 内 cleanup。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLoadError } from "../src/errors";
import { loadBuiltinSkills, loadFromDirectory, loadUserSkills } from "../src/loader";

const FIXTURE_SAMPLE_SKILL = join(__dirname, "..", "__fixtures__", "sample-skill");

describe("loadFromDirectory", () => {
  it("加载 sample-skill 返回完整 manifest + prompt", () => {
    const loaded = loadFromDirectory(FIXTURE_SAMPLE_SKILL);
    expect(loaded.manifest.id).toBe("fixture-skill");
    expect(loaded.manifest.title).toBe("Fixture Test Skill");
    expect(loaded.manifest.version).toBe("0.1.0");
    expect(loaded.manifest.category).toBe("communication");
    expect(loaded.manifest.riskLevel).toBe("draft_only");
    expect(loaded.manifest.allowedTools).toEqual([
      "mcp__opentrad__echo",
      "mcp__opentrad__draft_save",
    ]);
    expect(loaded.manifest.disallowedTools).toEqual(["Bash(*)", "mcp__*__send*"]);
    expect(loaded.manifest.inputs).toHaveLength(1);
    expect(loaded.manifest.inputs[0]?.name).toBe("topic");
    expect(loaded.manifest.outputs).toEqual(["draft"]);
    expect(loaded.promptTemplate).toContain("{{topic}}");
  });

  it("dir 不存在抛 SkillLoadError", () => {
    expect(() => loadFromDirectory("/nonexistent/path/to/skill")).toThrow(SkillLoadError);
  });

  it("skill.yml 缺必填字段时抛 SkillLoadError 包装 zod 错", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ot-skill-"));
    try {
      writeFileSync(
        join(tmp, "skill.yml"),
        "title: missing-id\nversion: 0.1.0\n", // 缺 id 等必填
      );
      expect(() => loadFromDirectory(tmp)).toThrow(SkillLoadError);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("promptTemplate 文件不存在抛 SkillLoadError", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ot-skill-"));
    try {
      writeFileSync(
        join(tmp, "skill.yml"),
        `id: x
title: Missing prompt
version: 0.1.0
description: test
category: other
riskLevel: read_only
allowedTools: []
inputs: []
outputs: []
promptTemplate: missing.md
`,
      );
      expect(() => loadFromDirectory(tmp)).toThrow(/prompt template not found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadBuiltinSkills", () => {
  let tmp: string;

  // 验收 4:5 个 skill 中 1 个故意损坏,只该 skill 标 ok:false,其他 4 个正常
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ot-builtin-"));
    for (let i = 1; i <= 4; i++) {
      const dir = join(tmp, `valid-${i}`);
      mkdirSync(dir);
      writeFileSync(
        join(dir, "skill.yml"),
        `id: valid-${i}
title: Valid ${i}
version: 0.1.0
description: valid skill ${i}
category: other
riskLevel: read_only
allowedTools: []
inputs: []
outputs: []
promptTemplate: prompt.md
`,
      );
      writeFileSync(join(dir, "prompt.md"), `Hello from ${i}`);
    }
    // 第 5 个故意损坏(yaml 合法但 schema 拒)
    const broken = join(tmp, "broken");
    mkdirSync(broken);
    writeFileSync(
      join(broken, "skill.yml"),
      "title: broken-no-id\nversion: 0.1.0\n", // 缺 id
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("5 个 manifest 中 4 个 ok + 1 个 broken,broken 不阻塞其他", () => {
    const results = loadBuiltinSkills(tmp);
    expect(results).toHaveLength(5);

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(ok).toHaveLength(4);
    expect(failed).toHaveLength(1);

    expect(failed[0]?.ok).toBe(false);
    if (failed[0]?.ok === false) {
      expect(failed[0].error).toBeInstanceOf(SkillLoadError);
      expect(failed[0].skillDir).toContain("broken");
    }

    const ids = ok
      .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
      .map((r) => r.skill.manifest.id)
      .sort();
    expect(ids).toEqual(["valid-1", "valid-2", "valid-3", "valid-4"]);
  });

  it("跳过非目录 entry(.DS_Store / 单文件)", () => {
    writeFileSync(join(tmp, ".DS_Store"), "");
    writeFileSync(join(tmp, "stray.txt"), "");
    const results = loadBuiltinSkills(tmp);
    // 还是 5 个(4 valid + 1 broken),非目录被跳过
    expect(results).toHaveLength(5);
  });

  it("dir 不存在抛 SkillLoadError", () => {
    expect(() => loadBuiltinSkills("/nonexistent/skills/dir")).toThrow(SkillLoadError);
  });
});

describe("loadUserSkills", () => {
  it("dir 不存在返回空数组(不抛)", () => {
    const results = loadUserSkills("/nonexistent/user/skills/dir");
    expect(results).toEqual([]);
  });

  it("dir 存在时委托 loadBuiltinSkills", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ot-user-"));
    try {
      const dir = join(tmp, "my-skill");
      mkdirSync(dir);
      writeFileSync(
        join(dir, "skill.yml"),
        `id: my-skill
title: My
version: 0.1.0
description: user
category: other
riskLevel: read_only
allowedTools: []
inputs: []
outputs: []
promptTemplate: prompt.md
`,
      );
      writeFileSync(join(dir, "prompt.md"), "user content");
      const results = loadUserSkills(tmp);
      expect(results).toHaveLength(1);
      expect(results[0]?.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
