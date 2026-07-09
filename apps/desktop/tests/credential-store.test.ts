// SafeStorageCredentialStore 单测：safeStorage 用 fake 注入（不 import electron）。
// 关注点：密文落库（非明文）、safeStorage 不可用时拒存拒读（绝不明文降级）、解密失败明确报错。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SafeStorageCredentialStore,
  type SafeStorageLike,
} from "../src/main/services/credential-store";
import { createDbServices, type DbServices } from "../src/main/services/db";

// fake safeStorage：可开关的可逆"加密"（base64 + 前缀标记——密文中不含明文子串，
// 让"落盘无明文"断言真实有效）
function fakeSafeStorage(available = true): SafeStorageLike & { available: boolean } {
  return {
    available,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(plainText: string): Buffer {
      return Buffer.from(`enc:${Buffer.from(plainText, "utf8").toString("base64")}`, "utf8");
    },
    decryptString(encrypted: Buffer): string {
      const raw = encrypted.toString("utf8");
      if (!raw.startsWith("enc:")) throw new Error("bad ciphertext");
      return Buffer.from(raw.slice(4), "base64").toString("utf8");
    },
  };
}

describe("SafeStorageCredentialStore", () => {
  let svc: DbServices;

  beforeEach(() => {
    svc = createDbServices({ dbPath: ":memory:" });
  });

  afterEach(() => {
    svc.close();
  });

  it("set + get 往返；SQLite 里存的是密文而非明文", async () => {
    const store = new SafeStorageCredentialStore(svc.db, fakeSafeStorage());
    await store.set("apikey:p1", "sk-secret-123");

    expect(await store.get("apikey:p1")).toBe("sk-secret-123");

    // 落库内容检查：ciphertext BLOB 不包含明文
    const row = svc.db
      .prepare("SELECT ciphertext FROM credentials WHERE ref = ?")
      .get("apikey:p1") as {
      ciphertext: Buffer;
    };
    const stored = row.ciphertext.toString("utf8");
    expect(stored).not.toContain("sk-secret-123");
    expect(stored.startsWith("enc:")).toBe(true);
  });

  it("同 ref 重复 set 覆盖旧值", async () => {
    const store = new SafeStorageCredentialStore(svc.db, fakeSafeStorage());
    await store.set("r", "old");
    await store.set("r", "new");
    expect(await store.get("r")).toBe("new");
  });

  it("不存在的 ref → null", async () => {
    const store = new SafeStorageCredentialStore(svc.db, fakeSafeStorage());
    expect(await store.get("ghost")).toBeNull();
  });

  it("delete 后读不到", async () => {
    const store = new SafeStorageCredentialStore(svc.db, fakeSafeStorage());
    await store.set("r", "v");
    await store.delete("r");
    expect(await store.get("r")).toBeNull();
  });

  it("safeStorage 不可用：set 拒绝且不落任何行（绝不明文落盘）", async () => {
    const store = new SafeStorageCredentialStore(svc.db, fakeSafeStorage(false));
    await expect(store.set("r", "sk-secret")).rejects.toThrow(/encryption unavailable/);
    const count = svc.db.prepare("SELECT COUNT(*) AS c FROM credentials").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("safeStorage 不可用：已有密文的 get 也拒绝（不猜不降级）", async () => {
    const ss = fakeSafeStorage(true);
    const store = new SafeStorageCredentialStore(svc.db, ss);
    await store.set("r", "v");
    ss.available = false;
    await expect(store.get("r")).rejects.toThrow(/encryption unavailable/);
  });

  it("解密失败（keychain 换机/密文损坏）：明确报错提示重填，错误不含 secret", async () => {
    const store = new SafeStorageCredentialStore(svc.db, fakeSafeStorage());
    // 直接写坏密文
    svc.db
      .prepare("INSERT INTO credentials (ref, ciphertext, updated_at) VALUES (?, ?, ?)")
      .run("bad", Buffer.from("garbage"), Date.now());
    await expect(store.get("bad")).rejects.toThrow(/decrypt failed.*re-enter/);
  });
});
