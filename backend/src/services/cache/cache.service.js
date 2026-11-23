import { getCacheClient, isRedisReady } from '../../config/redis.js';

/**
 * Cache Service — Redis cache-aside primitives with versioned tag invalidation.
 *
 * How invalidation works (no KEYS / SCAN):
 *   Every cached entry depends on one or more "tags", e.g. `tickets:org_abc:u:emp_101`.
 *   Each tag has a version counter in Redis (`cache:tagv:<tag>`). The version numbers are
 *   baked into the cache key, so bumping a tag (INCR) makes every dependent key
 *   unreachable instantly. Orphaned entries simply expire by TTL.
 *
 *   This also eliminates stale-write races of delete-based invalidation: a slow request
 *   that read old data before a mutation writes under the OLD version key, which nobody
 *   reads anymore.
 *
 * Everything here fails open: if Redis is down, reads return null and writes are skipped.
 */

export const CACHE_TTL = {
  BALANCE: 300, // 5 minutes
  TICKETS: 120, // 2 minutes
  NOTIFICATIONS: 60, // 1 minute
};

const TAG_VERSION_PREFIX = 'cache:tagv:';
const TAG_VERSION_TTL_SECONDS = 7 * 24 * 3600;

// Entries must expire long before tag versions do
export const MAX_ENTRY_TTL_SECONDS = 24 * 3600;

// Maximum payload size to store in cache; larger payloads are served uncached
export const MAX_ENTRY_BYTES = 512 * 1024;

/**
 * Clamp a TTL to the allowed range and add ±10% jitter to prevent synchronized cache misses.
 *
 * @param {number} ttlSeconds
 * @returns {number} Effective TTL with jitter applied
 */
export function effectiveTtl(ttlSeconds) {
  const base = Math.min(Math.max(1, Math.floor(Number(ttlSeconds) || 300)), MAX_ENTRY_TTL_SECONDS);
  const jitter = Math.floor(base * 0.1 * (Math.random() * 2 - 1));
  return Math.max(1, base + jitter);
}

// Lightweight counters exposed on /api/health
export const cacheStats = { hits: 0, misses: 0, skips: 0, errors: 0, invalidations: 0 };

function warn(op, key, err) {
  cacheStats.errors++;
  console.warn(`⚠️  [Cache] ${op} failed for "${key}": ${err.message}`);
}

/**
 * Read a JSON value from Redis. Returns null on miss, Redis down, or parse error.
 *
 * @param {string} key
 * @param {Object} [client]
 * @returns {Promise<Object|null>}
 */
export async function getCache(key, client = getCacheClient()) {
  if (!key || !isRedisReady(client)) return null;
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    warn('Read', key, err);
    return null;
  }
}

/**
 * Write a JSON value to Redis with TTL (seconds). Returns false when skipped or failed.
 *
 * @param {string} key
 * @param {*} data
 * @param {number} [ttlSeconds=300]
 * @param {Object} [client]
 * @returns {Promise<boolean>}
 */
export async function setCache(key, data, ttlSeconds = 300, client = getCacheClient()) {
  if (!key || data === undefined || !isRedisReady(client)) return false;
  try {
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) return false;
    await client.set(key, serialized, { EX: effectiveTtl(ttlSeconds) });
    return true;
  } catch (err) {
    warn('Write', key, err);
    return false;
  }
}

/**
 * Delete keys matching a pattern using SCAN (for maintenance / seed scripts).
 *
 * @param {string} pattern
 * @param {Object} [client]
 * @returns {Promise<boolean>}
 */
export async function invalidateCachePattern(pattern, client = getCacheClient()) {
  if (!pattern || !isRedisReady(client)) return false;
  try {
    let batch = [];
    for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      batch.push(key);
      if (batch.length >= 200) {
        await client.unlink(batch);
        batch = [];
      }
    }
    if (batch.length) await client.unlink(batch);
    return true;
  } catch (err) {
    warn('Pattern delete', pattern, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Versioned Tags
// ---------------------------------------------------------------------------

/**
 * Get current version for each tag (0 when never bumped).
 *
 * @param {string[]} tags
 * @param {Object} [client]
 * @returns {Promise<number[]|null>} null when Redis is unavailable
 */
export async function getTagVersions(tags, client = getCacheClient()) {
  if (!tags?.length) return [];
  if (!isRedisReady(client)) return null;
  try {
    const values = await client.mGet(tags.map((t) => TAG_VERSION_PREFIX + t));
    return values.map((v) => (v ? Number(v) : 0));
  } catch (err) {
    warn('Tag version read', tags.join(','), err);
    return null;
  }
}

/**
 * Bump tag versions: every cached entry depending on these tags becomes unreachable.
 *
 * @param {string[]} tags
 * @param {Object} [client]
 * @returns {Promise<boolean>}
 */
export async function invalidateTags(tags, client = getCacheClient()) {
  const list = [...new Set((tags || []).filter(Boolean))];
  if (!list.length || !isRedisReady(client)) return false;
  try {
    const multi = client.multi();
    for (const tag of list) {
      multi.incr(TAG_VERSION_PREFIX + tag);
      multi.expire(TAG_VERSION_PREFIX + tag, TAG_VERSION_TTL_SECONDS);
    }
    await multi.exec();
    cacheStats.invalidations += list.length;
    return true;
  } catch (err) {
    warn('Tag invalidation', list.join(','), err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tag Naming — single source of truth for cache dependency scopes
// ---------------------------------------------------------------------------

export const cacheTags = {
  /** Flush everything of a resource for an organization */
  orgFlush: (resource, orgId) => `${resource}:${orgId}:flush`,
  /** User-scoped data (their tickets, their balance, their notifications) */
  user: (resource, orgId, userId) => `${resource}:${orgId}:u:${userId}`,
  /** Organization-wide views (admin views across an entire tenant) */
  org: (resource, orgId) => `${resource}:${orgId}:all`,
};

/**
 * Invalidate ticket caches when a ticket is created or updated.
 * Refreshes the actor's user-scoped tickets and the org-wide view.
 */
export function invalidateTicketCaches({ orgId, userId }) {
  if (!orgId) return Promise.resolve(false);
  return invalidateTags([
    userId && cacheTags.user('tickets', orgId, userId),
    cacheTags.org('tickets', orgId),
  ]);
}

/**
 * Invalidate leave balance caches when a leave request is processed.
 */
export function invalidateBalanceCaches({ orgId, userId }) {
  if (!orgId || !userId) return Promise.resolve(false);
  return invalidateTags([cacheTags.user('balance', orgId, userId), cacheTags.org('balance', orgId)]);
}

/**
 * Flush every cached entry of a resource for an organization.
 */
export function invalidateResourceForOrg(orgId, resource) {
  if (!orgId || !resource) return Promise.resolve(false);
  return invalidateTags([cacheTags.orgFlush(resource, orgId)]);
}

/**
 * Invalidate unread notification badge counts for recipient users.
 */
export function invalidateNotificationCaches({ orgId, userIds = [] }) {
  if (!orgId || !userIds.length) return Promise.resolve(false);
  return invalidateTags(userIds.map((userId) => cacheTags.user('notifications', orgId, userId)));
}
