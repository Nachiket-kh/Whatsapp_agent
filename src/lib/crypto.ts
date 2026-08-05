import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key() {
  const value = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not configured.");
  return createHash("sha256").update(value).digest();
}

export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decrypt(value: string) {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted credential.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function secretHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
