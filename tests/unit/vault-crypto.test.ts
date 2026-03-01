import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { env } from "../../src/config/env";
import {
  decryptSecret,
  encryptSecret,
  getVaultEnvelopeInfo,
  getVaultKeyringMetadata,
  reencryptSecretPayload
} from "../../src/utils/vault-crypto";

function toB64(value: Buffer): string {
  return value.toString("base64url");
}

function encryptLegacyV1(secret: string): string {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(env.VAULT_SECRET).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${toB64(iv)}:${toB64(tag)}:${toB64(encrypted)}`;
}

test("vault crypto encrypts with v2 envelope and active key id", () => {
  const payload = encryptSecret("secret-value-1");
  const info = getVaultEnvelopeInfo(payload);
  const metadata = getVaultKeyringMetadata();

  assert.equal(info.version, "v2");
  assert.equal(info.keyId, metadata.activeKeyId);
  assert.equal(decryptSecret(payload), "secret-value-1");
});

test("vault crypto reencrypt is no-op when payload already uses active key", () => {
  const payload = encryptSecret("secret-value-2");
  const reencrypted = reencryptSecretPayload(payload);
  assert.equal(reencrypted.changed, false);
  assert.equal(reencrypted.payload, payload);
});

test("vault crypto decrypts legacy v1 payload and upgrades to active key", () => {
  const legacy = encryptLegacyV1("legacy-secret-value");
  assert.equal(decryptSecret(legacy), "legacy-secret-value");

  const upgraded = reencryptSecretPayload(legacy);
  const info = getVaultEnvelopeInfo(upgraded.payload);
  const metadata = getVaultKeyringMetadata();

  assert.equal(upgraded.changed, true);
  assert.equal(info.version, "v2");
  assert.equal(info.keyId, metadata.activeKeyId);
  assert.equal(decryptSecret(upgraded.payload), "legacy-secret-value");
});
