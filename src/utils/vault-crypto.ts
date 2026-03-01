import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

type VaultEnvelopeInfo = {
  version: "v1" | "v2" | "unknown";
  keyId: string | null;
};

type VaultKeyringMetadata = {
  activeKeyId: string;
  keyIds: string[];
};

type ReencryptResult = {
  changed: boolean;
  payload: string;
  from: VaultEnvelopeInfo;
  toKeyId: string;
};

type VaultKeyring = {
  activeKeyId: string;
  keys: Map<string, Buffer>;
  legacyV1Key: Buffer;
};

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function parseVaultKeyring(): VaultKeyring {
  const keys = new Map<string, Buffer>();
  const raw = typeof env.VAULT_KEYRING === "string" ? env.VAULT_KEYRING.trim() : "";

  if (raw.length > 0) {
    const parts = raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    for (const part of parts) {
      const separatorIndex = part.indexOf(":");
      if (separatorIndex <= 0 || separatorIndex >= part.length - 1) {
        continue;
      }

      const keyId = part.slice(0, separatorIndex).trim();
      const secret = part.slice(separatorIndex + 1).trim();
      if (!keyId || !secret) {
        continue;
      }

      keys.set(keyId, deriveKey(secret));
    }
  }

  const activeKeyId = env.VAULT_ACTIVE_KEY_ID.trim() || "local-default";
  if (!keys.has(activeKeyId)) {
    keys.set(activeKeyId, deriveKey(env.VAULT_SECRET));
  }

  return {
    activeKeyId,
    keys,
    legacyV1Key: deriveKey(env.VAULT_SECRET)
  };
}

const keyring = parseVaultKeyring();

function toB64(value: Buffer): string {
  return value.toString("base64url");
}

function fromB64(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12);
  const activeKey = keyring.keys.get(keyring.activeKeyId);
  if (!activeKey) {
    throw new Error(`Active vault key is not available: ${keyring.activeKeyId}`);
  }

  const cipher = createCipheriv("aes-256-gcm", activeKey, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v2:${keyring.activeKeyId}:${toB64(iv)}:${toB64(tag)}:${toB64(encrypted)}`;
}

export function getVaultEnvelopeInfo(payload: string): VaultEnvelopeInfo {
  const segments = payload.split(":");
  if (segments.length === 4 && segments[0] === "v1") {
    return {
      version: "v1",
      keyId: null
    };
  }

  if (segments.length === 5 && segments[0] === "v2") {
    const keyId = segments[1]?.trim();
    return {
      version: "v2",
      keyId: keyId && keyId.length > 0 ? keyId : null
    };
  }

  return {
    version: "unknown",
    keyId: null
  };
}

export function getVaultKeyringMetadata(): VaultKeyringMetadata {
  return {
    activeKeyId: keyring.activeKeyId,
    keyIds: [...keyring.keys.keys()].sort((a, b) => a.localeCompare(b))
  };
}

export function decryptSecret(payload: string): string {
  const envelope = getVaultEnvelopeInfo(payload);

  if (envelope.version === "v1") {
    const [version, ivRaw, tagRaw, encryptedRaw] = payload.split(":");
    if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) {
      throw new Error("Invalid encrypted payload format");
    }

    const decipher = createDecipheriv("aes-256-gcm", keyring.legacyV1Key, fromB64(ivRaw));
    decipher.setAuthTag(fromB64(tagRaw));
    const decrypted = Buffer.concat([decipher.update(fromB64(encryptedRaw)), decipher.final()]);

    return decrypted.toString("utf8");
  }

  if (envelope.version !== "v2" || !envelope.keyId) {
    throw new Error("Invalid encrypted payload format");
  }

  const key = keyring.keys.get(envelope.keyId);
  if (!key) {
    throw new Error(`Vault key id is not configured: ${envelope.keyId}`);
  }

  const [, keyIdRaw, ivRaw, tagRaw, encryptedRaw] = payload.split(":");
  if (!keyIdRaw || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Invalid encrypted payload format");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, fromB64(ivRaw));
  decipher.setAuthTag(fromB64(tagRaw));
  const decrypted = Buffer.concat([decipher.update(fromB64(encryptedRaw)), decipher.final()]);

  return decrypted.toString("utf8");
}

export function reencryptSecretPayload(payload: string): ReencryptResult {
  const from = getVaultEnvelopeInfo(payload);
  if (from.version === "v2" && from.keyId === keyring.activeKeyId) {
    return {
      changed: false,
      payload,
      from,
      toKeyId: keyring.activeKeyId
    };
  }

  const plain = decryptSecret(payload);
  const reencrypted = encryptSecret(plain);

  return {
    changed: true,
    payload: reencrypted,
    from,
    toKeyId: keyring.activeKeyId
  };
}

export function obfuscateSecret(value: string): string {
  if (value.length <= 4) {
    return "****";
  }

  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
