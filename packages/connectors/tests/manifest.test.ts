import { describe, expect, it } from "vitest";
import { parseConnectorManifest } from "../src/manifest";

const validManifest = {
  specVersion: 1,
  id: "shopify-admin",
  displayName: "Shopify Admin",
  description: "Shopify 店铺管理连接器",
  auth: { type: "oauth", credentialRef: "connector.shopify-admin.token" },
  actions: [
    {
      name: "get_products",
      description: "list products",
      inputSchema: { type: "object" },
      riskLevel: "safe",
      stopBefore: false,
    },
    {
      name: "publish_listing",
      description: "publish a listing to the store",
      inputSchema: { type: "object" },
      riskLevel: "review",
      stopBefore: true,
      businessAction: "publish_listing",
    },
  ],
};

describe("parseConnectorManifest", () => {
  it("接受合法 manifest", () => {
    const manifest = parseConnectorManifest(validManifest);
    expect(manifest.id).toBe("shopify-admin");
    expect(manifest.actions).toHaveLength(2);
  });

  it("stopBefore 动作缺 businessAction 时拒绝", () => {
    const bad = structuredClone(validManifest);
    const publishAction = bad.actions[1] as Record<string, unknown>;
    delete publishAction.businessAction;
    expect(() => parseConnectorManifest(bad)).toThrow(/businessAction/);
  });

  it("重复动作名拒绝", () => {
    const bad = structuredClone(validManifest);
    const publishAction = bad.actions[1] as (typeof bad.actions)[number];
    publishAction.name = "get_products";
    publishAction.stopBefore = false;
    expect(() => parseConnectorManifest(bad)).toThrow(/duplicate action/);
  });

  it("非法 id 格式拒绝", () => {
    const bad = structuredClone(validManifest);
    bad.id = "Shopify Admin!";
    expect(() => parseConnectorManifest(bad)).toThrow();
  });
});
