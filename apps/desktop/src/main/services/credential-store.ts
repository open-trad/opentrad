// SafeStorageCredentialStore：@opentrad/model-providers CredentialStore 的 Electron 实现。
//
// 安全边界（ADR-001 D2"凭证一律 Electron safeStorage，SQLite 只存引用/密文"）：
// - 明文只在内存中瞬时存在（set 入参 / get 返回值），落盘的只有 safeStorage 加密后的密文 BLOB
// - safeStorage 不可用（OS keychain 缺失，如部分 Linux 无 keyring）时**拒绝存取**，
//   绝不降级明文落盘；错误信息只带 ref，不带任何 secret 内容
// - safeStorage 经构造注入（SafeStorageLike 最小接口）：单测注入 fake，不 import electron
//
// 表结构见 db/schema.ts：credentials(ref TEXT PK, ciphertext BLOB, updated_at)。

import type { CredentialStore } from "@opentrad/model-providers";
import type Database from "better-sqlite3";

// Electron safeStorage 的最小接口面（结构兼容 import { safeStorage } from "electron"）
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface CredentialRawRow {
  ref: string;
  ciphertext: Buffer;
  updated_at: number;
}

export class SafeStorageCredentialStore implements CredentialStore {
  private readonly stmtUpsert;
  private readonly stmtGet;
  private readonly stmtDelete;

  constructor(
    db: Database.Database,
    private readonly safeStorage: SafeStorageLike,
  ) {
    this.stmtUpsert = db.prepare<[string, Buffer, number]>(
      `INSERT INTO credentials (ref, ciphertext, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
    );
    this.stmtGet = db.prepare<[string]>(`SELECT * FROM credentials WHERE ref = ?`);
    this.stmtDelete = db.prepare<[string]>(`DELETE FROM credentials WHERE ref = ?`);
  }

  async set(ref: string, secret: string): Promise<void> {
    this.requireEncryption(ref);
    const ciphertext = this.safeStorage.encryptString(secret);
    this.stmtUpsert.run(ref, ciphertext, Date.now());
  }

  async get(ref: string): Promise<string | null> {
    const row = this.stmtGet.get(ref) as CredentialRawRow | undefined;
    if (!row) return null;
    this.requireEncryption(ref);
    try {
      return this.safeStorage.decryptString(row.ciphertext);
    } catch {
      // 解密失败（keychain 换机/损坏）：按"凭证不存在"处理会误导上层写新 key 覆盖，
      // 明确抛错让用户在 Settings 重新填 key。错误只带 ref。
      throw new Error(`credential decrypt failed for ref ${ref}; please re-enter the key`);
    }
  }

  async delete(ref: string): Promise<void> {
    this.stmtDelete.run(ref);
  }

  private requireEncryption(ref: string): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      // 绝不明文落盘：OS keychain 不可用即拒绝（log 英文、不带 secret）
      throw new Error(
        `safeStorage encryption unavailable; refusing plaintext credential storage (ref ${ref})`,
      );
    }
  }
}
