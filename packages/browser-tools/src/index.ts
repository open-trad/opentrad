// @opentrad/browser-tools 入口(M1 #27)。
// BrowserService(单例 + page lifecycle)+ DomSnapshot 类型/抽取算法。

export {
  BrowserService,
  type BrowserServiceOptions,
  type NewPageResult,
} from "./browser-service";
export { type DomSnapshot, extractDomSnapshot, snapshotToText } from "./dom-snapshot";
export type {
  BrowserHandle,
  BrowserLauncher,
  LaunchOptions,
  PageHandle,
  ScreenshotOptions,
} from "./types";
