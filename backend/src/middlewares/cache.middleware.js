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
 *   router.get('/', cacheResponse({ ttl: 120, tag: 'tickets', query: ['status', 'page'] }), controller)
 *
 * Response header X-Cache tells you exactly what happened:
 *   HIT         served from Redis, controller skipped
 *   MISS        controller ran, response stored
 *   COALESCED   an identical request was already running; shared its response
 *   BYPASS      caller sent X-Cache-Bypass: 1 (non-production only)
 *   UNCACHEABLE request had a query param not listed in `query` — served uncached
 *   SKIP        cache Redis not ready — controller ran, nothing stored
 *
 * Production safeguards:
 *  - Cache keys are built ONLY from whitelisted query params, sorted. Arbitrary query
 *    strings can't create unbounded keys, and ?a&b / ?b&a share one entry.
 *  - Requests carrying unknown params are served uncached instead of being keyed
 *    on a subset, so a param the controller starts honouring later can never be
 *    answered with another filter's cached response.
 *  - Identical concurrent misses are coalesced in-process (one DB query, not fifty).
 *  - TTL jitter, max entry size and TTL cap are applied in cache.service.
 *  - The browser's `Cache-Control: no-cache` is ignored (Chrome DevTools sends it on
 *    every request with "Disable cache" ticked).
 *
 * @param {Object} options
 * @param {number} [options.ttl=300] Seconds
 * @param {string} options.tag Resource name, e.g. 'tickets' | 'balance'
 * @param {'user'|'org'} [options.scope='user'] Key isolation level
 * @param {string[]} [options.query=[]] Query params that change the response
 * @param {(req) => string[]} [options.tags] Tags this response depends on.
 *        Defaults: user scope → that user's tag; org scope → the org-wide tag.
 */

const isProduction = () => config.nodeEnv === 'production';

const MAX_PARAM_LENGTH = 100;
const COALESCE_WAIT_MS = 5000;

// cacheKey -> Promise<{ status, body } | null> for misses currently being computed
const inflight = new Map();

/**
 * Build the canonical query segment from whitelisted params.
 * @returns {string|null} null when the request has params outside the whitelist
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
    if (req.method !== 'GET' || !req.user?.orgId) {
      return next();
    }

    // Authenticated, per-user data: never let browsers' shared caches or proxies keep it
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.headers?.['x-cache-bypass'] === '1' && !isProduction()) {
      res.setHeader('X-Cache', 'BYPASS');
      return next();
    }

    const querySegment = canonicalQuery(req.query, query);
    if (querySegment === null) {
      res.setHeader('X-Cache', 'UNCACHEABLE');
      return next();
    }

    const { orgId, userId } = req.user;
    const scopeSegment = scope === 'org' ? `org_${orgId}` : `u_${userId}`;
    const path = `${req.baseUrl || ''}${req.path || ''}`;
    const baseKey = `cache:http:${orgId}:${tag}:${scopeSegment}:${path}?${querySegment}`;

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
    if (!isProduction()) {
      res.setHeader('X-Cache-Key', cacheKey);
    }

    const cached = await getCache(cacheKey);
    if (cached && cached.body !== undefined) {
      cacheStats.hits++;
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Age', Math.max(0, Math.floor((Date.now() - (cached.storedAt || Date.now())) / 1000)));
      return res.status(cached.status || 200).json(cached.body);
    }

    // Another request is already computing this exact response: wait for it
    if (inflight.has(cacheKey)) {
      const shared = await waitForInflight(inflight.get(cacheKey));
      if (shared) {
        cacheStats.hits++;
        res.setHeader('X-Cache', 'COALESCED');
        return res.status(shared.status).json(shared.body);
      }
      // Leader failed or timed out — compute independently
    }

    cacheStats.misses++;
    res.setHeader('X-Cache', 'MISS');

    // Become the leader for this key
    let settle;
    const leaderPromise = new Promise((resolve) => {
      settle = (value) => {
        if (inflight.get(cacheKey) === leaderPromise) inflight.delete(cacheKey);
        resolve(value);
      };
    });
    if (!inflight.has(cacheKey)) {
      inflight.set(cacheKey, leaderPromise);
    }

    // Response never produced JSON (error handler, client abort...): release followers
    res.on('close', () => settle(null));

    const originalJson = res.json.bind(res);
    res.json = function cacheCapturingJson(body) {
      res.json = originalJson;
      const ok = res.statusCode >= 200 && res.statusCode < 300 && body && body.success !== false;
      if (ok) {
        const entry = { status: res.statusCode, body, storedAt: Date.now() };
        settle(entry);
        // Fire-and-forget: never delay the response for the cache write
        setCache(cacheKey, entry, ttl);
      } else {
        settle(null);
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
