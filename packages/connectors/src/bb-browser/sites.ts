// 站点目录已迁移到 @opentrad/shared（纯数据，无 node 依赖）——这样 renderer 可直接
// import BB_SITES 而不会经 connectors 入口拖入 runner.ts 的 node:child_process
// （vite dev 不 tree-shake，会在浏览器端抛 "Module node:child_process externalized"）。
// 本文件保留为 re-export，兼容 connectors 内部与既有 import 路径。

export { BB_SITES, type BbSite, getBbSite, type SiteArg } from "@opentrad/shared";
