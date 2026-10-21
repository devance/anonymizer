/**
 * The encryption format shared by the Worker and the processor: AES-256-GCM,
 * `[version 1][12-byte IV][ciphertext + tag]`, with associated data naming
 * where the value lives ("text:<doc id>", "entities:<id>:real"…) so a blob
 * moved to another row fails to decrypt. WebCrypto only, so it runs in both.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** WebCrypto takes any byte view; this only satisfies the differing lib typings of Workers, Node and the DOM. */
const raw = (u: Uint8Array) => u as unknown as ArrayBuffer;

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function importDataKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.length !== 32) throw new Error('data keys are 32 bytes');
  return crypto.subtle.importKey('raw', raw(rawKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealBytes(key: CryptoKey, plain: Uint8Array, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: raw(iv), additionalData: raw(enc.encode(aad)) }, key, raw(plain)));
  const out = new Uint8Array(13 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

export async function openBytes(key: CryptoKey, sealed: Uint8Array, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed[0] !== 1) throw new Error('unknown ciphertext version');
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw(sealed.subarray(1, 13)), additionalData: raw(enc.encode(aad)) }, key, raw(sealed.subarray(13))),
  );
}

export async function sealText(key: CryptoKey, plain: string, aad: string): Promise<string> {
  return b64(await sealBytes(key, enc.encode(plain), aad));
}

export async function openText(key: CryptoKey, sealed: string, aad: string): Promise<string> {
  return dec.decode(await openBytes(key, unb64(sealed), aad));
}

export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<string> {
  return sealText(key, JSON.stringify(value), aad);
}

export async function openJson<T>(key: CryptoKey, sealed: string, aad: string): Promise<T> {
  return JSON.parse(await openText(key, sealed, aad)) as T;
}

/** Associated data for each kind of sealed value. */
export const aad = {
  file: (docId: string) => `file:${docId}`,
  text: (docId: string) => `text:${docId}`,
  work: (docId: string) => `work:${docId}`,
  fields: (docId: string) => `fields:${docId}`,
  entityReal: (entityId: string) => `entities:${entityId}:real`,
  filename: (docId: string) => `documents:${docId}:filename`,
};
