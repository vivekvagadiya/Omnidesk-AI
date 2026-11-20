import {
  getCache,
  setCache,
  getTagVersions,
  invalidateTags,
  invalidateResourceForOrg,
  cacheTags,
  cacheStats,
  CACHE_TTL,
} from '../services/cache/cache.service.js';
import { config } from '../config/environment.js';

/**
 * Route-Level Response Cache
 *
 * Mount AFTER authenticateJwt so RBAC always runs and req.user is known.
 *
 *   router.get('/balance', cacheResponse({ ttl: 300, tag: 'balance' }), controller)
 *
 * Response header X-Cache tells you exactly what happened:
 *   HIT    served from Redis, controller skipped
 *   MISS   controller ran, response stored
 *   BYPASS caller sent X-Cache-Bypass: 1 (non-production only)
 *   SKIP   Redis not ready — controller ran, nothing stored (check Redis!)
 *
 * NOTE: the browser's `Cache-Control: no-cache` header is deliberately ignored.
 * Chrome DevTools sends it on every request while "Disable cache" is ticked,
 * which made the old middleware bypass Redis for every request during development.
 *
 * @param {Object} options
 * @param {number} [options.ttl=300] Seconds
 * @param {string} options.tag Resource name, e.g. 'tickets' | 'balance'
 * @param {'user'|'org'} [options.scope='user'] Key isolation level
 * @param {(req) => string[]} [options.tags] Tags this response depends on.
 *        Defaults: user scope → that user's tag; org scope → the org-wide tag.
 * @param {(req) => string} [options.keyGenerator] Custom base key
 */
export function cacheResponse(options = {}) {
  const { ttl = CACHE_TTL.BALANCE, tag = 'route', scope = 'user', tags = null, keyGenerator = null } = options;

  return async function cacheMiddleware(req, res, next) {
    if (req.method !== 'GET' || !req.user?.orgId) {
      return next();
    }

    if (req.headers?.['x-cache-bypass'] === '1' && config.nodeEnv !== 'production') {
      res.setHeader('X-Cache', 'BYPASS');
      return next();
    }

    const { orgId, userId } = req.user;

    let baseKey = null;
    if (typeof keyGenerator === 'function') {
      try {
        baseKey = keyGenerator(req);
      } catch (err) {
        console.warn(`⚠️ [Cache Middleware] Key generator failed: ${err.message}`);
      }
    }
    if (!baseKey) {
      const scopeSegment = scope === 'org' ? `org_${orgId}` : `u_${userId}`;
      baseKey = `cache:http:${orgId}:${tag}:${scopeSegment}:${req.originalUrl || req.url}`;
    }

    // Resolve dependency tags (always include the org-wide flush tag)
    let dependencyTags;
    try {
      dependencyTags =
        typeof tags === 'function'
          ? tags(req)
          : [scope === 'org' ? cacheTags.org(tag, orgId) : cacheTags.user(tag, orgId, userId)];
    } catch (err) {
      console.warn(`⚠️ [Cache Middleware] Tag resolver failed: ${err.message}`);
      return next();
    }
    dependencyTags = [cacheTags.orgFlush(tag, orgId), ...dependencyTags.filter(Boolean)];

    const versions = await getTagVersions(dependencyTags);
    if (versions === null) {
      cacheStats.skips++;
      res.setHeader('X-Cache', 'SKIP');
      return next();
    }

    const cacheKey = `${baseKey}|v${versions.join('.')}`;
    res.setHeader('X-Cache-Key', cacheKey);

    const cached = await getCache(cacheKey);
    if (cached && cached.body !== undefined) {
      cacheStats.hits++;
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Age', Math.max(0, Math.floor((Date.now() - (cached.storedAt || Date.now())) / 1000)));
      return res.status(cached.status || 200).json(cached.body);
    }

    cacheStats.misses++;
    res.setHeader('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = function cacheCapturingJson(body) {
      res.json = originalJson;
      const ok = res.statusCode >= 200 && res.statusCode < 300 && body && body.success !== false;
      if (ok) {
        // Fire-and-forget: never delay the response for the cache write
        setCache(cacheKey, { status: res.statusCode, body, storedAt: Date.now() }, ttl);
      }
      return originalJson(body);
    };

    return next();
  };
}

/**
 * Route-level invalidation for routes that only mutate through REST.
 * Bumps tags once the response finished with 2xx.
 *
 * Prefer the service-level helpers (invalidateTicketCaches, invalidateBalanceCaches)
 * when the same mutation can also happen from the copilot chat / HITL approvals.
 *
 * @param {(req, res) => string[]} tagsResolver
 */
export function invalidateCache(tagsResolver) {
  return function invalidateCacheMiddleware(req, res, next) {
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      try {
        const tagList = typeof tagsResolver === 'function' ? tagsResolver(req, res) : tagsResolver;
        invalidateTags(Array.isArray(tagList) ? tagList : [tagList]);
      } catch (err) {
        console.warn(`⚠️ [Cache Invalidation] ${err.message}`);
      }
    });
    next();
  };
}

/**
 * Flush every cached response of a resource for an org (kept for backwards compatibility).
 */
export function invalidateHttpCache(orgId, resource) {
  return invalidateResourceForOrg(orgId, resource);
}
