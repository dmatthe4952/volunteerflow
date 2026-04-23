import crypto from 'node:crypto';

const ENCRYPTED_PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export function isEncryptedSettingValue(value: string): boolean {
  return String(value ?? '').startsWith(ENCRYPTED_PREFIX);
}

export function encryptSettingValue(plainText: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, encrypted]).toString('base64');
  return `${ENCRYPTED_PREFIX}${payload}`;
}

export function decryptSettingValue(value: string, secret: string): string {
  if (!isEncryptedSettingValue(value)) return String(value ?? '');
  const b64 = String(value).slice(ENCRYPTED_PREFIX.length);
  const payload = Buffer.from(b64, 'base64');
  if (payload.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('Invalid encrypted setting payload.');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const authTag = payload.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const encrypted = payload.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString('utf8');
}
