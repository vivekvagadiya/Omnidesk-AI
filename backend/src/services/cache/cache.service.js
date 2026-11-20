import { getRedisClient, isRedisReady } from '../../config/redis.js';

/**
 * Cache Service — Redis cache-aside primitives with versioned tag invalidation.
 *
 * How invalidation works (no KEYS / SCAN):
 *   Every cached entry depends on one or more "tags", e.g. `tickets:org_abc:u:emp_101`.
 *   Each tag has a version counter in Redis (`cache:tagv:<tag>`). The version numbers are
 *   baked into the cache key, so bumping a tag (INCR) makes every dependent key
 *   unreachable instantly. Orphaned entries simply expire by TTL.
 *
 *   This also removes the stale-write race of delete-based invalidation: a slow request
 *   that read old data before a mutation writes under the OLD version key, which nobody
 *   reads anymore.
 *
 * Everything here fails open: if Redis is down, reads return null and writes are skipped.
 */

export const CACHE_TTL = {
  BALANCE: 300, // 5 minutes
  TICKETS: 120, // 2 minutes
};

const TAG_VERSION_PREFIX = 'cache:tagv:';
const TAG_VERSION_TTL_SECONDS = 7 * 24 * 3600; // far longer than any entry TTL

// Lightweight counters exposed on /api/health
export const cacheStats = { hits: 0, misses: 0, skips: 0, errors: 0, invalidations: 0 };

function warn(op, key, err) {
  cacheStats.errors++;
  console.warn(`⚠️  [Cache] ${op} failed for "${key}": ${err.message}`);
}

/**
 * Read a JSON value. Returns null on miss, Redis down, or error.
 */
export async function getCache(key, client = getRedisClient()) {
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
 * Write a JSON value with TTL (seconds). Returns false when skipped or failed.
 */
export async function setCache(key, data, ttlSeconds = 300, client = getRedisClient()) {
  if (!key || data === undefined || !isRedisReady(client)) return false;
  try {
    await client.set(key, JSON.stringify(data), { EX: ttlSeconds });
    return true;
  } catch (err) {
    warn('Write', key, err);
    return false;
  }
}

/**
 * Delete a single key.
 */
export async function invalidateCacheKey(key, client = getRedisClient()) {
  if (!key || !isRedisReady(client)) return false;
  try {
    await client.del(key);
    return true;
  } catch (err) {
    warn('Delete', key, err);
    return false;
  }
}

/**
 * Delete keys by glob pattern using SCAN (non-blocking, unlike KEYS).
 * For maintenance/scripts only — request paths should use tag invalidation.
 */
export async function invalidateCachePattern(pattern, client = getRedisClient()) {
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
// Versioned tags
// ---------------------------------------------------------------------------

/**
 * Current version for each tag (0 when never bumped).
 * @returns {Promise<number[]|null>} null when Redis is unavailable
 */
export async function getTagVersions(tags, client = getRedisClient()) {
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
 */
export async function invalidateTags(tags, client = getRedisClient()) {
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
// Tag naming — the single place that defines what depends on what
// ---------------------------------------------------------------------------

export const cacheTags = {
  /** Bump to flush everything of a resource for an org (admin/maintenance) */
  orgFlush: (resource, orgId) => `${resource}:${orgId}:flush`,
  /** Data owned by one user (their tickets, their balance) */
  user: (resource, orgId, userId) => `${resource}:${orgId}:u:${userId}`,
  /** Org-wide views (admin "all tickets") */
  org: (resource, orgId) => `${resource}:${orgId}:all`,
};

/**
 * A user's tickets changed: refresh their own lists and every org-wide list.
 */
export function invalidateTicketCaches({ orgId, userId }) {
  if (!orgId) return Promise.resolve(false);
  return invalidateTags([
    userId && cacheTags.user('tickets', orgId, userId),
    cacheTags.org('tickets', orgId),
  ]);
}

/**
 * A user's leave balance changed: refresh only that user's balance.
 */
export function invalidateBalanceCaches({ orgId, userId }) {
  if (!orgId || !userId) return Promise.resolve(false);
  return invalidateTags([cacheTags.user('balance', orgId, userId), cacheTags.org('balance', orgId)]);
}

/**
 * Flush every cached response of a resource for an org.
 */
export function invalidateResourceForOrg(orgId, resource) {
  if (!orgId || !resource) return Promise.resolve(false);
  return invalidateTags([cacheTags.orgFlush(resource, orgId)]);
}
