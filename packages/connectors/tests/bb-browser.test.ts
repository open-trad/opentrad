// bb-browser 连接器测试：注入假 spawn，不起真实进程/浏览器。

import { EventEmitter } from "node:events";
import { ToolHost } from "@opentrad/tool-host";
import { describe, expect, it } from "vitest";
import { registerBbSites, siteToolDescriptor } from "../src/bb-browser/index";
import { buildSiteArgs, runBbBrowser } from "../src/bb-browser/runner";
import { BB_SITES, getBbSite } from "../src/bb-browser/sites";

// 造一个假 child process：可控 stdout/stderr/exit
function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number; errorMsg?: string }) {
  return () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    // 异步触发，模拟真实进程
    queueMicrotask(() => {
      if (opts.errorMsg) {
        child.emit("error", new Error(opts.errorMsg));
        return;
      }
      if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      child.emit("close", opts.code ?? 0);
    });
    return child as never;
  };
}

describe("BB_SITES 目录", () => {
  it("站点 id 唯一，必带 keyword/query 必填参数", () => {
    const ids = BB_SITES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of BB_SITES) {
      expect(s.args.some((a) => a.required)).toBe(true);
      expect(s.command).toContain("/");
      expect(s.toolRisk).toBe("safe");
    }
  });

  it("发起人本地私有适配器四站在目录内", () => {
    for (const id of ["1688", "taobao", "pdd", "amazon"]) {
      expect(getBbSite(id), `缺 ${id}`).toBeDefined();
    }
  });
});

describe("buildSiteArgs", () => {
  it("映射必填/可选参数为 --key value", () => {
    const site = getBbSite("taobao")!;
    const args = buildSiteArgs(site, { keyword: "耳机", sort: "sales" });
    expect(args).toEqual([
      "site",
      "taobao/search-products",
      "--keyword",
      "耳机",
      "--sort",
      "sales",
    ]);
  });

  it("缺必填参数返回错误结果不 spawn", () => {
    const site = getBbSite("taobao")!;
    const r = buildSiteArgs(site, {});
    expect(Array.isArray(r)).toBe(false);
    expect((r as { error: string }).error).toContain("keyword");
  });
});

describe("runBbBrowser 错误分层", () => {
  it("成功：解包 {result:...}", async () => {
    const r = await runBbBrowser(["site", "google/search"], 5000, {
      spawnFn: fakeSpawn({ stdout: '{"result":{"count":2,"results":[1,2]}}' }),
    });
    expect(r.ok).toBe(true);
    expect((r.data as { count: number }).count).toBe(2);
  });

  it("适配器三层错误：透传 error/hint/action", async () => {
    const r = await runBbBrowser(["site", "taobao/search-products"], 5000, {
      spawnFn: fakeSpawn({
        stdout:
          '{"error":"未获取到商品","hint":"请先在浏览器登录淘宝","action":"bb-browser open https://s.taobao.com"}',
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未获取到商品");
    expect(r.hint).toContain("登录淘宝");
    expect(r.action).toContain("bb-browser open");
  });

  it("CLI 层浏览器未就绪：给友好 hint + daemon:start action", async () => {
    const r = await runBbBrowser(["site", "google/search"], 5000, {
      spawnFn: fakeSpawn({
        stderr: "错误：bb-browser: Cannot find a Chromium-based browser.",
        code: 1,
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("浏览器未就绪");
    expect(r.action).toBe("daemon:start");
  });

  it("CLI 未安装（ENOENT）：给安装指引", async () => {
    const r = await runBbBrowser(["--version"], 5000, {
      spawnFn: fakeSpawn({ errorMsg: "spawn bb-browser ENOENT" }),
    });
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("npm install -g bb-browser");
  });

  it("daemon 层对象形态错误 {error:{message}}：解包为失败，不误判成功", async () => {
    // 发起人实机遇到的"调用插件失败"根因：早期把对象形态 error 误判为成功透传
    const r = await runBbBrowser(["site", "google/search"], 5000, {
      spawnFn: fakeSpawn({
        stdout:
          '{"error":{"message":"Daemon HTTP 400: {\\"error\\":{\\"message\\":\\"No page target found\\"}}"}}',
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("No page target");
    expect(r.hint).toContain("标签页");
  });

  it("超时：返回超时错误不挂起", async () => {
    // 假 spawn 永不 close
    const hangSpawn = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      return child as never;
    };
    const r = await runBbBrowser(["site", "x"], 50, { spawnFn: hangSpawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超时");
  });
});

describe("registerBbSites", () => {
  it("注册启用站点为 site:<id> 工具，执行走 spawn", async () => {
    const host = new ToolHost(async () => ({ decision: "allow" }));
    const names = registerBbSites(host, ["google", "taobao"], {
      spawnFn: fakeSpawn({ stdout: '{"result":{"ok":true}}' }),
    });
    expect(names).toEqual(["site:google", "site:taobao"]);
    const result = await host.execute("site:google", { query: "usb hub" });
    expect(result.isError).toBeUndefined();
    expect((result.output as { ok: boolean }).ok).toBe(true);
  });

  it("工具执行遇适配器错误：isError + 合成 error/hint/action 文本喂回", async () => {
    const host = new ToolHost(async () => ({ decision: "allow" }));
    registerBbSites(host, ["taobao"], {
      spawnFn: fakeSpawn({ stdout: '{"error":"未获取到","hint":"先登录","action":"open taobao"}' }),
    });
    const result = await host.execute("site:taobao", { keyword: "耳机" });
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain("先登录");
  });

  it("未知站点 id 跳过", () => {
    const host = new ToolHost(async () => ({ decision: "allow" }));
    const names = registerBbSites(host, ["nope"], {});
    expect(names).toEqual([]);
  });

  it("siteToolDescriptor：只读站点 riskLevel=safe，schema 含必填", () => {
    const d = siteToolDescriptor(getBbSite("taobao")!);
    expect(d.riskLevel).toBe("safe");
    expect(d.source).toBe("connector");
    expect((d.inputSchema as { required: string[] }).required).toContain("keyword");
  });
});
