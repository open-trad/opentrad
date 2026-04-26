// DOM snapshot 提取算法(M1 #27 issue body §架构决策):
// - <title>
// - <h1>-<h3>
// - 可见 text(innerText 限定根元素深度 5)
// - <a> 链接(限 50 个)
//
// 这个函数会被 playwright `page.evaluate` 序列化到 browser context 执行,
// **不能引用模块作用域内的任何东西**(闭包变量、import 等都不可用),
// 必须 self-contained。返回值经 JSON 序列化回 Node 进程。
//
// M2 视 skill 需求增强(读结构化表格 / 表单字段 / 价格抽取等)。

export interface DomSnapshot {
  title: string;
  url: string;
  headings: { level: 1 | 2 | 3; text: string }[];
  visibleText: string; // 已截断到 ~3.5KB 留 buffer
  links: { href: string; text: string }[]; // 限 50 个
}

// 在 page context 内运行的纯函数(self-contained,不依赖外部 import)。
// 单测时 fake page.evaluate 不会真跑这个 fn,只 stub 返回值;
// 真 e2e 时(发起人 dev 校验)playwright 把它序列化进 chromium。
export function extractDomSnapshot(): DomSnapshot {
  // 在 browser context 内 document 可用
  const doc = document;
  const win = window;

  const headings: { level: 1 | 2 | 3; text: string }[] = [];
  for (const tag of ["h1", "h2", "h3"] as const) {
    const elems = doc.querySelectorAll(tag);
    for (const el of Array.from(elems)) {
      const t = (el.textContent ?? "").trim();
      if (t) {
        headings.push({
          level: Number.parseInt(tag[1] ?? "0", 10) as 1 | 2 | 3,
          text: t.slice(0, 200),
        });
      }
    }
  }

  // 可见 text:body.innerText(浏览器自带可见性过滤),截断到 ~3.5KB
  const rawText = doc.body?.innerText ?? "";
  const visibleText = rawText.length > 3500 ? `${rawText.slice(0, 3500)}…[truncated]` : rawText;

  // <a> 链接,限 50 个,跳空 href
  const linkElems = Array.from(doc.querySelectorAll("a")).slice(0, 200);
  const links: { href: string; text: string }[] = [];
  for (const a of linkElems) {
    const href = (a as HTMLAnchorElement).href;
    if (!href || href.startsWith("javascript:")) continue;
    const text = (a.textContent ?? "").trim().slice(0, 100);
    links.push({ href, text });
    if (links.length >= 50) break;
  }

  return {
    title: doc.title,
    url: win.location.href,
    headings,
    visibleText,
    links,
  };
}

// 把 DomSnapshot 序列化成给 LLM 看的 plaintext 摘要(目标 ≤5KB)。
// LLM 友好格式:Markdown-ish 但不严格 markdown(避免 CC 把它当成 markdown 渲染)。
export function snapshotToText(snap: DomSnapshot): string {
  const lines: string[] = [];
  lines.push(`URL: ${snap.url}`);
  lines.push(`Title: ${snap.title}`);
  if (snap.headings.length > 0) {
    lines.push("");
    lines.push("Headings:");
    for (const h of snap.headings.slice(0, 30)) {
      lines.push(`  ${"#".repeat(h.level)} ${h.text}`);
    }
  }
  if (snap.visibleText) {
    lines.push("");
    lines.push("Visible text:");
    lines.push(snap.visibleText);
  }
  if (snap.links.length > 0) {
    lines.push("");
    lines.push(`Links (${snap.links.length}):`);
    for (const l of snap.links) {
      lines.push(`  - [${l.text || "(no text)"}] ${l.href}`);
    }
  }
  return lines.join("\n");
}
