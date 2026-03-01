import { randomUUID } from "node:crypto";
import { all, get, run } from "../db/sqlite";
import {
  decryptSecret,
  encryptSecret,
  getVaultEnvelopeInfo,
  getVaultKeyringMetadata,
  obfuscateSecret,
  reencryptSecretPayload
} from "../utils/vault-crypto";

type VaultRow = {
  id: string;
  user_id: string;
  label: string;
  encrypted_value: string;
  created_at: string;
  updated_at: string;
};

export async function storeVaultSecret(userId: string, label: string, secret: string): Promise<{ keysRef: string; masked: string }> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const encryptedValue = encryptSecret(secret);

  await run(
    `
      INSERT INTO vault_entries (id, user_id, label, encrypted_value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [id, userId, label, encryptedValue, now, now]
  );

  return {
    keysRef: id,
    masked: obfuscateSecret(secret)
  };
}

export async function resolveVaultSecret(userId: string, keysRef: string): Promise<string | null> {
  const row = await get<VaultRow>("SELECT * FROM vault_entries WHERE id = ? AND user_id = ?", [keysRef, userId]);
  if (!row) {
    return null;
  }

  return decryptSecret(row.encrypted_value);
}

export async function getVaultMetadata(userId: string, keysRef: string): Promise<{ keysRef: string; label: string } | null> {
  const row = await get<{ id: string; label: string }>("SELECT id, label FROM vault_entries WHERE id = ? AND user_id = ?", [
    keysRef,
    userId
  ]);

  if (!row) {
    return null;
  }

  return {
    keysRef: row.id,
    label: row.label
  };
}

export type VaultRotationResult = {
  scanned: number;
  rotated: number;
  unchanged: number;
  failed: number;
  failures: Array<{
    keysRef: string;
    reason: string;
  }>;
  activeKeyId: string;
};

export async function rotateVaultSecrets(input?: { userId?: string; limit?: number }): Promise<VaultRotationResult> {
  const limit = Math.max(1, Math.min(10_000, Math.trunc(input?.limit ?? 1000)));
  const hasUserFilter = typeof input?.userId === "string" && input.userId.trim().length > 0;

  const rows = hasUserFilter
    ? await all<VaultRow>(
        `
          SELECT id, user_id, label, encrypted_value, created_at, updated_at
          FROM vault_entries
          WHERE user_id = ?
          ORDER BY updated_at ASC
          LIMIT ?
        `,
        [input?.userId as string, limit]
      )
    : await all<VaultRow>(
        `
          SELECT id, user_id, label, encrypted_value, created_at, updated_at
          FROM vault_entries
          ORDER BY updated_at ASC
          LIMIT ?
        `,
        [limit]
      );

  let rotated = 0;
  let unchanged = 0;
  let failed = 0;
  const failures: VaultRotationResult["failures"] = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    try {
      const next = reencryptSecretPayload(row.encrypted_value);
      if (!next.changed) {
        unchanged += 1;
        continue;
      }

      await run(
        `
          UPDATE vault_entries
          SET encrypted_value = ?, updated_at = ?
          WHERE id = ?
        `,
        [next.payload, now, row.id]
      );
      rotated += 1;
    } catch (error) {
      failed += 1;
      failures.push({
        keysRef: row.id,
        reason: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  return {
    scanned: rows.length,
    rotated,
    unchanged,
    failed,
    failures,
    activeKeyId: getVaultKeyringMetadata().activeKeyId
  };
}

export type VaultSecurityStatus = {
  activeKeyId: string;
  availableKeyIds: string[];
  totals: {
    entries: number;
    v1: number;
    v2: number;
    unknown: number;
  };
  byKeyId: Array<{
    keyId: string;
    entries: number;
  }>;
};

export async function getVaultSecurityStatus(input?: { userId?: string; limit?: number }): Promise<VaultSecurityStatus> {
  const limit = Math.max(1, Math.min(20_000, Math.trunc(input?.limit ?? 5000)));
  const hasUserFilter = typeof input?.userId === "string" && input.userId.trim().length > 0;

  const rows = hasUserFilter
    ? await all<Pick<VaultRow, "encrypted_value">>(
        `
          SELECT encrypted_value
          FROM vault_entries
          WHERE user_id = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `,
        [input?.userId as string, limit]
      )
    : await all<Pick<VaultRow, "encrypted_value">>(
        `
          SELECT encrypted_value
          FROM vault_entries
          ORDER BY updated_at DESC
          LIMIT ?
        `,
        [limit]
      );

  let v1 = 0;
  let v2 = 0;
  let unknown = 0;
  const byKeyCounter = new Map<string, number>();

  for (const row of rows) {
    const info = getVaultEnvelopeInfo(row.encrypted_value);
    if (info.version === "v1") {
      v1 += 1;
      continue;
    }

    if (info.version === "v2" && info.keyId) {
      v2 += 1;
      byKeyCounter.set(info.keyId, (byKeyCounter.get(info.keyId) ?? 0) + 1);
      continue;
    }

    unknown += 1;
  }

  const metadata = getVaultKeyringMetadata();
  return {
    activeKeyId: metadata.activeKeyId,
    availableKeyIds: metadata.keyIds,
    totals: {
      entries: rows.length,
      v1,
      v2,
      unknown
    },
    byKeyId: [...byKeyCounter.entries()]
      .map(([keyId, entries]) => ({ keyId, entries }))
      .sort((a, b) => b.entries - a.entries)
  };
}
