import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { config } from "../config";

// AES-256-GCM, keyed by CRYPTO_KEY (32 random bytes, base64). Used only to
// encrypt Google refresh tokens at rest in the `resources` table. The key is
// resolved lazily (not at module load) so importing this file never fails
// just because CRYPTO_KEY isn't set yet — only an actual encrypt/decrypt call does.
function getKey(): Buffer {
  if (!config.cryptoKey) throw new Error("Missing required env var: CRYPTO_KEY");
  const key = Buffer.from(config.cryptoKey, "base64");
  if (key.length !== 32) throw new Error("CRYPTO_KEY must decode to exactly 32 bytes (base64-encoded)");
  return key;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decrypt(stored: string): string {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = stored.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
