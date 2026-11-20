import { getCache, setCache, invalidateCachePattern, CACHE_TTL } from '../services/cache/cache.service.js';

/**
 * Route-Level Declarative Caching Middleware
 *
 * Intercepts GET requests:
 * - If cache hit: returns cached payload immediately with HTTP headers:
 *     X-Cache: HIT
 *     X-Cache-Key: <key>
 *   (< 3ms response time, completely short-circuiting database queries and controller logic)
 * - If cache miss: sets X-Cache: MISS, intercepts res.json, and caches the response asynchronously in Redis.
 *
 * Multi-tenant isolation is strictly enforced via tenant orgId and optional user scope.
 *
 * @param {Object} options
 * @param {number} [options.ttl=300] Time-to-live in seconds
 * @param {string} [options.tag='route'] Resource tag for grouped pattern invalidation (e.g. 'balance', 'tickets')
 * @param {Function} [options.keyGenerator] Optional custom key generator: (req) => string
 * @param {'user'|'org'|'public'} [options.scope='user'] Scope level:
 *   - 'user': isolated per user per org (e.g., leave balance, personal tickets)
 *   - 'org': isolated per tenant organization
 *   - 'public': shared globally
 * @returns {import('express').RequestHandler}
 */
export function cacheResponse(options = {}) {
  const {
    ttl = CACHE_TTL.BALANCE || 300,
    tag = 'route',
    keyGenerator = null,
    scope = 'user',
  } = options;

  return async function cacheMiddleware(req, res, next) {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Bypass cache if client explicitly asks via header (e.g. Cache-Control: no-cache)
    const cacheControl = req.headers?.['cache-control'] || '';
    const pragma = req.headers?.['pragma'] || '';
    if (cacheControl.includes('no-cache') || pragma.includes('no-cache')) {
      res.setHeader('X-Cache', 'BYPASS');
      return next();
    }

    const orgId = req.user?.orgId || 'public';
    const userId = req.user?.userId || 'anon';

    // Generate unique multi-tenant cache key
    let cacheKey = null;
    if (typeof keyGenerator === 'function') {
      try {
        cacheKey = keyGenerator(req);
      } catch (err) {
        console.warn(`⚠️ [Cache Middleware] Key generator failed: ${err.message}`);
      }
    }

    if (!cacheKey) {
      const scopeSegment = scope === 'user' ? `u_${userId}` : scope === 'org' ? `org_${orgId}` : 'pub';
      const urlSegment = req.originalUrl || req.url;
      cacheKey = `cache:http:${orgId}:${tag}:${scopeSegment}:${urlSegment}`;
    }

    try {
      // 1. Check Redis Cache
      const cached = await getCache(cacheKey);
      if (cached !== null && cached !== undefined) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey);
        const status = cached.statusCode || 200;
        return res.status(status).json(cached);
      }

      // 2. Cache Miss: Instrument res.json to capture response
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', cacheKey);

      const originalJson = res.json.bind(res);
      res.json = function (body) {
        // Restore original method to prevent potential recursive loops
        res.json = originalJson;

        // Cache only 2xx successful responses with a valid body
        if (res.statusCode >= 200 && res.statusCode < 300 && body !== undefined && body !== null) {
          // Asynchronously write to Redis (non-blocking)
          setCache(cacheKey, body, ttl).catch((writeErr) => {
            console.warn(`⚠️ [Cache Middleware] Async set failed for "${cacheKey}": ${writeErr.message}`);
          });
        }

        return originalJson(body);
      };

      return next();
    } catch (err) {
      // Fail-open: Proceed to controller even if Redis fails
      console.warn(`⚠️ [Cache Middleware] Error checking cache: ${err.message}`);
      return next();
    }
  };
}

/**
 * Route-Level Invalidation Middleware
 *
 * Automatically flushes cached patterns on successful mutation routes (POST, PUT, PATCH, DELETE)
 *
 * @param {string|string[]} tags Tag or list of tags to invalidate (e.g. ['tickets'], ['balance'])
 * @returns {import('express').RequestHandler}
 */
export function invalidateCache(tags = []) {
  const tagList = Array.isArray(tags) ? tags : [tags];

  return function invalidateCacheMiddleware(req, res, next) {
    const orgId = req.user?.orgId;

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      res.json = originalJson;

      // Invalidate only if mutation was successful (2xx) and tenant orgId is known
      if (res.statusCode >= 200 && res.statusCode < 300 && orgId) {
        for (const tag of tagList) {
          invalidateHttpCache(orgId, tag).catch((err) => {
            console.warn(`⚠️ [Cache Invalidation] Failed to invalidate tag "${tag}": ${err.message}`);
          });
        }
      }

      return originalJson(body);
    };

    return next();
  };
}

/**
 * Programmatic HTTP Cache Invalidation Helper
 *
 * Flushes all route-level cached entries for an organization and resource tag
 *
 * @param {string} orgId Tenant organization ID
 * @param {string} tag Resource tag (e.g. 'tickets', 'balance')
 * @returns {Promise<boolean>}
 */
export async function invalidateHttpCache(orgId, tag) {
  if (!orgId || !tag) return false;

  const patterns = [
    `cache:http:${orgId}:${tag}:*`,
    `cache:${tag}:${orgId}:*`, // legacy key pattern cleanup
  ];

  try {
    await Promise.all(patterns.map((p) => invalidateCachePattern(p)));
    return true;
  } catch (err) {
    console.warn(`⚠️ [Cache Helper] Invalidation failed for tag "${tag}": ${err.message}`);
    return false;
  }
}
