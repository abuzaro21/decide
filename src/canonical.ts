import { createHash } from 'node:crypto';

// RFC 8785 (JCS): strings and numbers serialize exactly as ECMAScript JSON.stringify,
// object keys sorted by UTF-16 code units (the default JS sort). Non-finite numbers are invalid.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JCS: non-finite number');
    if (value === undefined || typeof value === 'function' || typeof value === 'bigint') throw new Error('JCS: unsupported value');
    if (typeof value === 'string' && !value.isWellFormed()) throw new Error('JCS: lone surrogate');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  for (const k of keys) if (!k.isWellFormed()) throw new Error('JCS: lone surrogate in key');
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const digest = (value: unknown): string => sha256(canonicalize(value));
