import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY_NAME = 'brio.connect.dpop.p256.v1';
const encoder = new TextEncoder();
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

type PublicJWK = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

function encodeBase64URL(value: Uint8Array) {
  let output = '';
  for (let index = 0; index < value.length; index += 3) {
    const a = value[index] ?? 0;
    const b = value[index + 1] ?? 0;
    const c = value[index + 2] ?? 0;
    const combined = (a << 16) | (b << 8) | c;
    output += base64Alphabet[(combined >>> 18) & 63];
    output += base64Alphabet[(combined >>> 12) & 63];
    if (index + 1 < value.length) output += base64Alphabet[(combined >>> 6) & 63];
    if (index + 2 < value.length) output += base64Alphabet[combined & 63];
  }
  return output;
}

function decodeBase64URL(value: string) {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const position = base64Alphabet.indexOf(character);
    if (position < 0) throw new Error('Invalid base64url value');
    buffer = (buffer << 6) | position;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}

async function readKey() {
  if (Platform.OS === 'web') return indexedDBValue('readonly');
  return SecureStore.getItemAsync(KEY_NAME);
}

async function writeKey(value: string) {
  if (Platform.OS === 'web') {
    await indexedDBValue('readwrite', value);
    return;
  }
  await SecureStore.setItemAsync(KEY_NAME, value);
}

function indexedDBValue(mode: IDBTransactionMode, value?: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const open = globalThis.indexedDB.open('brio-connect-keys', 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('keys')) open.result.createObjectStore('keys');
    };
    open.onerror = () => reject(open.error ?? new Error('Could not open the Brio key store'));
    open.onsuccess = () => {
      const transaction = open.result.transaction('keys', mode);
      const store = transaction.objectStore('keys');
      const request = value === undefined ? store.get(KEY_NAME) : store.put(value, KEY_NAME);
      request.onerror = () => reject(request.error ?? new Error('Could not access the Brio key'));
      request.onsuccess = () => resolve(value === undefined ? (request.result as string | undefined) ?? null : value);
      transaction.oncomplete = () => open.result.close();
    };
  });
}

async function privateKey() {
  const stored = await readKey();
  if (stored) {
    const decoded = decodeBase64URL(stored);
    if (p256.utils.isValidSecretKey(decoded)) return decoded;
  }
  const key = p256.utils.randomSecretKey(Crypto.getRandomBytes(48));
  await writeKey(encodeBase64URL(key));
  return key;
}

function publicJWK(key: Uint8Array): PublicJWK {
  const publicKey = p256.getPublicKey(key, false);
  return {
    kty: 'EC',
    crv: 'P-256',
    x: encodeBase64URL(publicKey.slice(1, 33)),
    y: encodeBase64URL(publicKey.slice(33, 65)),
  };
}

function canonicalHTU(raw: string) {
  const url = new URL(raw);
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function getDPoPThumbprint() {
  const jwk = publicJWK(await privateKey());
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return encodeBase64URL(sha256(encoder.encode(canonical)));
}

export async function createDPoPProof(method: string, url: string, accessToken?: string) {
  const key = await privateKey();
  const jwk = publicJWK(key);
  const header = encodeBase64URL(
    encoder.encode(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk })),
  );
  const claims: Record<string, string | number> = {
    htm: method.toUpperCase(),
    htu: canonicalHTU(url),
    iat: Math.floor(Date.now() / 1000),
    jti: encodeBase64URL(Crypto.getRandomBytes(18)),
  };
  if (accessToken) claims.ath = encodeBase64URL(sha256(encoder.encode(accessToken)));
  const payload = encodeBase64URL(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = p256.sign(encoder.encode(signingInput), key, { format: 'compact' });
  return `${signingInput}.${encodeBase64URL(signature)}`;
}
