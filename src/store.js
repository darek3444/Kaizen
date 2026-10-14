// Offline-first storage: localStorage is the source of truth for the UI,
// Supabase (when signed in) is synced in the background with debounced upserts.
import { supabase } from './supabase.js';

const PREFIX = 'kz:';
export const KEYS = ['daily-log', 'tasks', 'config'];
const DIRTY_KEY = PREFIX + '_dirty'; // keys changed locally but not yet uploaded
const UID_KEY = PREFIX + '_uid';     // which account the local cache belongs to
const EMAIL_KEY = PREFIX + '_email'; // shown in the footer before the session is verified
const FLUSH_DELAY = 800;

let userId = null;
let flushTimer = null;
let flushing = false;
const versions = new Map(); // key -> local edit counter, guards against races during upload
let onStatus = () => {};
let retryTimer = null;
let retryDelay = 5000; // grows to 60 s while the server keeps failing

const dirty = new Set(readRaw(DIRTY_KEY, []));

function readRaw(fullKey, fallback) {
  try {
    const raw = localStorage.getItem(fullKey);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeRaw(fullKey, value) {
  try {
    localStorage.setItem(fullKey, JSON.stringify(value));
  } catch (e) {
    console.error('storage error', fullKey, e);
  }
}
function persistDirty() {
  writeRaw(DIRTY_KEY, [...dirty]);
}
function status(s, detail = '') {
  onStatus(s, detail);
}
function failed(error) {
  console.error('sync error', error);
  status(navigator.onLine ? 'error' : 'offline', error?.message || String(error));
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => (dirty.size ? flush() : pull()), retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60000);
}
function recovered() {
  clearTimeout(retryTimer);
  retryDelay = 5000;
}

export function get(key, fallback) {
  return readRaw(PREFIX + key, fallback);
}

export function set(key, value) {
  writeRaw(PREFIX + key, value);
  versions.set(key, (versions.get(key) || 0) + 1);
  if (!userId) return;
  dirty.add(key);
  persistDirty();
  status('pending');
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_DELAY);
}

export function setStatusListener(cb) {
  onStatus = cb;
}

export function hasPendingWrites() {
  return dirty.size > 0 || flushing;
}

export async function flush() {
  clearTimeout(flushTimer);
  if (!userId || !dirty.size || flushing) return;
  // a key without a local value can't be uploaded (the column is NOT NULL) — drop it
  [...dirty].forEach((k) => get(k, null) === null && dirty.delete(k));
  if (!dirty.size) { persistDirty(); return; }
  flushing = true;
  const keys = [...dirty];
  const snapshot = new Map(keys.map((k) => [k, versions.get(k) || 0]));
  const now = new Date().toISOString();
  const rows = keys.map((key) => ({ user_id: userId, key, value: get(key, null), updated_at: now }));
  status('saving');
  let error;
  try {
    ({ error } = await supabase.from('kv_store').upsert(rows));
  } catch (e) {
    error = e;
  }
  flushing = false;
  if (error) return failed(error);
  recovered();
  // only clear keys that weren't edited again while the request was in flight
  keys.forEach((k) => {
    if ((versions.get(k) || 0) === snapshot.get(k)) dirty.delete(k);
  });
  persistDirty();
  if (dirty.size) flush();
  else status('synced');
}

// Pulls remote state into the local cache. Returns true if anything changed.
// Keys with unsent local edits are never overwritten.
export async function pull() {
  if (!userId || flushing) return false;
  let data, error;
  try {
    ({ data, error } = await supabase.from('kv_store').select('key,value').in('key', KEYS));
  } catch (e) {
    error = e;
  }
  if (error) {
    failed(error);
    return false;
  }
  recovered();
  const remote = Object.fromEntries(data.map((r) => [r.key, r.value]));
  let changed = false;
  for (const key of KEYS) {
    if (dirty.has(key)) continue;
    const local = localStorage.getItem(PREFIX + key);
    if (key in remote) {
      const serialized = JSON.stringify(remote[key]);
      if (serialized !== local) {
        localStorage.setItem(PREFIX + key, serialized);
        changed = true;
      }
    } else if (local !== null) {
      // first sign-in on this device: upload whatever was stored locally
      dirty.add(key);
    }
  }
  persistDirty();
  if (dirty.size) flush();
  else status('synced');
  return changed;
}

export function cachedAccount() {
  return { uid: readRaw(UID_KEY, null), email: readRaw(EMAIL_KEY, '') };
}

// Starts queueing local edits for upload under the cached account, without any
// network round-trip — lets the app open instantly; connect() verifies later.
export function prime(uid) {
  userId = uid;
}

// Returns true if remote data changed the local cache.
export async function connect(uid, email = '') {
  const previousUid = readRaw(UID_KEY, null);
  if (previousUid && previousUid !== uid) {
    // a different account used this browser before — don't leak its cache
    clearLocal();
  }
  writeRaw(UID_KEY, uid);
  if (email) writeRaw(EMAIL_KEY, email);
  userId = uid;
  return pull();
}

export function clearLocal() {
  [...KEYS, '_dirty', '_uid', '_email'].forEach((k) => localStorage.removeItem(PREFIX + k));
  dirty.clear();
}

window.addEventListener('online', () => flush());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flush();
});
