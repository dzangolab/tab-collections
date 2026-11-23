// The sync file (ADR 0001, "The sync file" and "Encryption").
//
// Plain: the Export format (buildExport) plus `tombstones: [{ id, deletedAt }]`, so the file can
// also be imported by hand. Encrypted: an envelope whose `data` is that JSON, encrypted with
// AES-GCM under a key derived from the passphrase with PBKDF2 (WebCrypto has no Argon2).

import { buildExport, EXPORT_FORMAT } from '../common.js';
import { emptySnapshot } from './merge.js';

export const ENCRYPTED_FORMAT = 'tab-collections-encrypted';
export const PBKDF2_ITERATIONS = 600_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const utf8ToBase64 = (text) => toBase64(enc.encode(text));
export const base64ToUtf8 = (b64) => dec.decode(fromBase64(b64.replace(/\s/g, '')));

export class SyncFileError extends Error {}

// ---------- Snapshot ⇄ plain JSON ----------

export function snapshotToJson(snapshot) {
  const out = buildExport(Object.values(snapshot.collections).sort((a, b) => a.id.localeCompare(b.id)));
  out.tombstones = Object.entries(snapshot.tombstones)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, deletedAt]) => ({ id, deletedAt }));
  delete out.exportedAt; // would make every sync a change of the file
  return out;
}

export function jsonToSnapshot(data) {
  if (data?.format !== EXPORT_FORMAT || !Array.isArray(data.collections)) {
    throw new SyncFileError('The sync file isn’t a Tab Collections file.');
  }
  const snap = emptySnapshot();
  for (const c of data.collections) {
    if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || !Array.isArray(c.pages)) continue;
    snap.collections[c.id] = {
      id: c.id,
      name: c.name,
      description: typeof c.description === 'string' ? c.description : '',
      pages: c.pages.filter((p) => p && typeof p.url === 'string' && p.url).map((p) => ({ url: p.url, title: String(p.title || '') })),
      createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
      updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
    };
    if (!snap.collections[c.id].pages.length) delete snap.collections[c.id];
  }
  for (const t of data.tombstones || []) {
    if (t && typeof t.id === 'string' && typeof t.deletedAt === 'number' && !snap.collections[t.id]) {
      snap.tombstones[t.id] = t.deletedAt;
    }
  }
  return snap;
}

// ---------- Encryption ----------

const keys = new Map(); // `${salt}|${iterations}|${passphrase}` → CryptoKey (deriving takes a moment)

async function deriveKey(passphrase, salt, iterations) {
  const id = `${toBase64(salt)}|${iterations}|${passphrase}`;
  if (!keys.has(id)) {
    const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    keys.set(id, await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    ));
  }
  return keys.get(id);
}

export async function encrypt(text, passphrase, { salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PBKDF2_ITERATIONS } = {}) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
  return {
    format: ENCRYPTED_FORMAT,
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    data: toBase64(data),
  };
}

export async function decrypt(envelope, passphrase) {
  if (!passphrase) throw new SyncFileError('The sync file is encrypted. Enter its passphrase in the sync settings.');
  const salt = fromBase64(envelope.kdf.salt);
  const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.cipher.iv) }, key, fromBase64(envelope.data));
    return dec.decode(plain);
  } catch {
    throw new SyncFileError('Wrong passphrase: the sync file can’t be decrypted.');
  }
}

// ---------- Text ⇄ snapshot ----------

// Returns { snapshot, encrypted, salt }. `text` null (no sync file yet) gives an empty snapshot.
export async function readSyncFile(text, passphrase) {
  if (text == null || text.trim() === '') return { snapshot: emptySnapshot(), encrypted: null, salt: null };
  let data;
  try { data = JSON.parse(text); } catch { throw new SyncFileError('The sync file isn’t valid JSON.'); }
  if (data?.format === ENCRYPTED_FORMAT) {
    const json = JSON.parse(await decrypt(data, passphrase));
    return { snapshot: jsonToSnapshot(json), encrypted: true, salt: fromBase64(data.kdf.salt) };
  }
  if (passphrase) {
    throw new SyncFileError('Encryption is on, but the sync file isn’t encrypted. Turn encryption off, or use another file.');
  }
  return { snapshot: jsonToSnapshot(data), encrypted: false, salt: null };
}

// `salt`: reuse the file's, so the key isn't derived again on every sync.
export async function writeSyncFile(snapshot, passphrase, salt = null) {
  const json = JSON.stringify(snapshotToJson(snapshot), null, 2) + '\n';
  if (!passphrase) return json;
  return JSON.stringify(await encrypt(json, passphrase, salt ? { salt } : {}), null, 2) + '\n';
}
