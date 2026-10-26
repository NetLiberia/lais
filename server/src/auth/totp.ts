import { createHmac, randomBytes } from 'node:crypto';

// Time-based one-time passwords (RFC 6238, HMAC-SHA1, 30 s step, 6 digits),
// compatible with common authenticator apps.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

export function totp(secretBase32: string, timeMs = Date.now(), digits = 6): string {
  return hotp(base32Decode(secretBase32), Math.floor(timeMs / 1000 / 30), digits);
}

/** Accepts the current step and one step either side to allow for clock drift. */
export function verifyTotp(secretBase32: string, code: string, timeMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(timeMs / 1000 / 30);
  return [-1, 0, 1].some((d) => hotp(secret, step + d) === code);
}

export function otpauthUri(secretBase32: string, username: string): string {
  const label = encodeURIComponent(`LAIS:${username}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=LAIS&algorithm=SHA1&digits=6&period=30`;
}
