import { getRedisClient } from '../../config/redis.js';

export const CACHE_TTL = {
  BALANCE: 300, // 5 minutes TTL for user balance and quotas
  TICKETS: 120, // 2 minutes TTL for paginated ticket queries
};

/**
 * Retrieve JSON-deserialized cached item from Redis
 * Fail-open pattern: returns null on cache miss, offline status, or errors
 *
 * @param {string} key Cache key
 * @param {import('redis').RedisClientType} [client]
 * @returns {Promise<any|null>}
 */
export async function getCache(key, client = getRedisClient()) {
  if (!client || !client.isOpen || !key) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`⚠️  [Cache] Read notice on "${key}": ${err.message}`);
    return null;
  }
}

/**
 * Store JSON-serialized item into Redis with TTL (in seconds)
 * Fail-open pattern: catches errors silently without failing requests
 *
 * @param {string} key Cache key
 * @param {any} data Serializable payload
 * @param {number} [ttlSeconds=300] Time-to-live in seconds
 * @param {import('redis').RedisClientType} [client]
 * @returns {Promise<boolean>}
 */
export async function setCache(key, data, ttlSeconds = 300, client = getRedisClient()) {
  if (!client || !client.isOpen || !key || data === undefined) return false;
  try {
    const serialized = JSON.stringify(data);
    await client.set(key, serialized, { EX: ttlSeconds });
    return true;
  } catch (err) {
    console.warn(`⚠️  [Cache] Write notice on "${key}": ${err.message}`);
    return false;
  }
}

/**
 * Invalidate a specific cache key
 *
 * @param {string} key Cache key to delete
 * @param {import('redis').RedisClientType} [client]
 * @returns {Promise<boolean>}
 */
export async function invalidateCacheKey(key, client = getRedisClient()) {
  if (!client || !client.isOpen || !key) return false;
  try {
    await client.del(key);
    return true;
  } catch (err) {
    console.warn(`⚠️  [Cache] Invalidate notice on "${key}": ${err.message}`);
    return false;
  }
}

/**
 * Invalidate all cache keys matching a glob pattern (e.g. "cache:tickets:org_abc:*")
 *
 * @param {string} pattern Glob pattern
 * @param {import('redis').RedisClientType} [client]
 * @returns {Promise<boolean>}
 */
export async function invalidateCachePattern(pattern, client = getRedisClient()) {
  if (!client || !client.isOpen || !pattern) return false;
  try {
    const keys = await client.keys(pattern);
    if (keys && keys.length > 0) {
      await client.del(keys);
    }
    return true;
  } catch (err) {
    console.warn(`⚠️  [Cache] Pattern invalidate notice on "${pattern}": ${err.message}`);
    return false;
  }
}
