import {
  getCache,
  setCache,
  getTagVersions,
  cacheTags,
  cacheStats,
  CACHE_TTL,
} from '../services/cache/cache.service.js';
import { config } from '../config/environment.js';

/**
 * Route-Level Response Cache Middleware
 *
 * Mount AFTER authenticateJwt so authentication and RBAC have already run.
 *
 * Usage:
 *   router.get('/endpoint', cacheResponse({ ttl: 120, tag: 'tickets', query: ['status', 'page'] }), controller);
 *
 * Response Header X-Cache:
 *   HIT         Served from Redis, controller skipped
 *   MISS        Controller ran, response stored in Redis
 *   COALESCED   An identical request was already running; shared its response
 *   BYPASS      Caller sent X-Cache-Bypass: 1 (non-production only)
 *   UNCACHEABLE Request had a query param outside whitelist — served live
 *   SKIP        Cache Redis unavailable — controller ran live, nothing stored
 *
 * Key Properties:
 *  - Tenant isolation: All keys and dependency tags are prefixed with orgId.
 *  - Scope isolation: User scope prefixes with u_${userId}; Org scope prefixes with org_${orgId}.
 *  - Sensitive response safety: Cache-Control is set to 'private, no-store'.
 *  - Only GET requests are cached. Mutations (POST, PUT, PATCH, DELETE) and auth routes are NEVER cached.
 *  - Request coalescing: In-flight identical requests are coalesced into a single DB execution.
 *  - Hang-prevention: In-flight promises settle cleanly on finish, close, or a 5-second timeout.
 */

const isProduction = () => config.nodeEnv === 'production';

const MAX_PARAM_LENGTH = 100;
const COALESCE_WAIT_MS = 5000;

// cacheKey -> Promise<{ status, body } | null> for in-flight requests
const inflight = new Map();

/**
 * Build the canonical query segment from whitelisted params.
 *
 * @param {Object} reqQuery Express req.query
 * @param {string[]} allowed Allowed query parameter names
 * @returns {string|null} null when the request contains unwhitelisted query params
 */
function canonicalQuery(reqQuery, allowed) {
  const present = Object.keys(reqQuery || {});
  if (present.some((name) => !allowed.includes(name))) return null;

  return [...allowed]
    .sort()
    .filter((name) => reqQuery[name] !== undefined && reqQuery[name] !== '')
    .map((name) => {
      const raw = Array.isArray(reqQuery[name]) ? reqQuery[name].join(',') : String(reqQuery[name]);
      return `${name}=${encodeURIComponent(raw.slice(0, MAX_PARAM_LENGTH))}`;
    })
    .join('&');
}

/**
 * Wait for an in-flight request to finish, capped by COALESCE_WAIT_MS.
 *
 * @param {Promise} promise
 * @returns {Promise<Object|null>}
 */
function waitForInflight(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), COALESCE_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function cacheResponse(options = {}) {
  const { ttl = CACHE_TTL.BALANCE, tag = 'route', scope = 'user', query = [], tags = null } = options;

  return async function cacheMiddleware(req, res, next) {
    // 1. Never cache non-GET methods or unauthenticated requests
    if (req.method !== 'GET' || !req.user?.orgId) {
      return next();
    }

    // 2. Prevent downstream proxies or shared browser caches from storing user data
    res.setHeader('Cache-Control', 'private, no-store');

    // 3. Optional bypass in development / test environments
    if (req.headers?.['x-cache-bypass'] === '1' && !isProduction()) {
      res.setHeader('X-Cache', 'BYPASS');
      return next();
    }

    // 4. Validate query parameters against whitelist to prevent unbounded cache key generation
    const querySegment = canonicalQuery(req.query, query);
    if (querySegment === null) {
      res.setHeader('X-Cache', 'UNCACHEABLE');
      return next();
    }

    const { orgId, userId } = req.user;
    const scopeSegment = scope === 'org' ? `org_${orgId}` : `u_${userId}`;
    const path = `${req.baseUrl || ''}${req.path || ''}`;
    const baseKey = `cache:http:${orgId}:${tag}:${scopeSegment}:${path}?${querySegment}`;

    // 5. Resolve dependency tags for versioned invalidation
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

    // 6. Read tag versions. If Redis is unavailable, fail open (SKIP)
    const versions = await getTagVersions(dependencyTags);
    if (versions === null) {
      cacheStats.skips++;
      res.setHeader('X-Cache', 'SKIP');
      return next();
    }

    const cacheKey = `${baseKey}|v${versions.join('.')}`;
    if (!isProduction()) {
      res.setHeader('X-Cache-Key', cacheKey);
    }

    // 7. Check cache HIT in Redis
    const cached = await getCache(cacheKey);
    if (cached && cached.body !== undefined) {
      cacheStats.hits++;
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Age', Math.max(0, Math.floor((Date.now() - (cached.storedAt || Date.now())) / 1000)));
      return res.status(cached.status || 200).json(cached.body);
    }

    // 8. Request coalescing: If an identical request is currently computing, wait for its result
    if (inflight.has(cacheKey)) {
      const shared = await waitForInflight(inflight.get(cacheKey));
      if (shared) {
        cacheStats.hits++;
        res.setHeader('X-Cache', 'COALESCED');
        return res.status(shared.status).json(shared.body);
      }
      // If leader timed out or failed, fall through to compute independently
    }

    cacheStats.misses++;
    res.setHeader('X-Cache', 'MISS');

    // 9. Become leader for this cacheKey
    let settle;
    const leaderPromise = new Promise((resolve) => {
      settle = (value) => {
        if (inflight.get(cacheKey) === leaderPromise) {
          inflight.delete(cacheKey);
        }
        resolve(value);
      };
    });

    // Safety timeout to prevent any lingering in-flight entries
    const safetyTimer = setTimeout(() => settle(null), 10000);
    leaderPromise.finally(() => clearTimeout(safetyTimer));

    if (!inflight.has(cacheKey)) {
      inflight.set(cacheKey, leaderPromise);
    }

    // Settle promise if client disconnects or request finishes without sending JSON
    res.once('close', () => settle(null));
    res.once('finish', () => settle(null));

    // 10. Intercept res.json to capture successful responses
    const originalJson = res.json.bind(res);
    res.json = function cacheCapturingJson(body) {
      res.json = originalJson;
      const ok = res.statusCode >= 200 && res.statusCode < 300 && body && body.success !== false;
      if (ok) {
        const entry = { status: res.statusCode, body, storedAt: Date.now() };
        settle(entry);
        // Fire-and-forget: do not block the client response for the cache write
        setCache(cacheKey, entry, ttl);
      } else {
        settle(null);
      }
      return originalJson(body);
    };

    return next();
  };
}
