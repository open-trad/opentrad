import { readFileSync } from "node:fs";
import type { HermesRuntimeInstallProgress } from "@opentrad/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HermesRuntimeInstallProgressNotice } from "../src/renderer/features/agent/AgentChatPanel";

function render(progress: HermesRuntimeInstallProgress): string {
  return renderToStaticMarkup(createElement(HermesRuntimeInstallProgressNotice, { progress }));
}

describe("HermesRuntimeInstallProgressNotice", () => {
  it("shows the active installation phase and artifact", () => {
    const html = render({ phase: "downloading", artifact: "hermes-wheel" });

    expect(html).toContain("正在下载");
    expect(html).toContain("Hermes wheel");
    expect(html).toContain('data-runtime-install-phase="downloading"');
  });

  it("shows non-artifact phases without inventing diagnostics", () => {
    const html = render({ phase: "verifying-runtime" });

    expect(html).toContain("正在校验运行时");
    expect(html).not.toContain("http");
    expect(html).not.toContain("secret");
  });

  it("wires HomeHero session startup to the managed runtime progress notice", () => {
    const source = readFileSync(
      new URL("../src/renderer/features/shell/AppShell.tsx", import.meta.url),
      "utf8",
    );
    const homeHeroSource = source.slice(
      source.indexOf("function HomeHero"),
      source.indexOf("// 自定义模型选择 pill"),
    );

    expect(homeHeroSource).toContain(
      "const runtimeInstallProgress = useAgentStore((s) => s.runtimeInstallProgress);",
    );
    expect(homeHeroSource).toMatch(
      /\{starting && runtimeInstallProgress \? \(\s*<HermesRuntimeInstallProgressNotice progress=\{runtimeInstallProgress\} \/>/,
    );
  });
});
