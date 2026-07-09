// React 入口。对应 03-architecture.md §2 apps/desktop/src/renderer/index.tsx。
// M0 范围：把 <App /> 挂到 #root。Zustand store / Router 等留到 Issue #7 / #8。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
