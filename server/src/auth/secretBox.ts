import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM for small secrets stored in the database (MFA seeds).
// In a production deployment the key should come from a managed key service, not an env file.

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function open(sealed: string, key: Buffer): string {
  const [iv, tag, ct] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
