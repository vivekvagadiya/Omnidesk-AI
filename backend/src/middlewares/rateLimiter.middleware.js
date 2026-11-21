import { getRedisClient } from '../config/redis.js';
import { errorResponse } from '../utils/apiResponse.js';

/**
 * Atomic fixed-window counter: INCR + expiry in ONE server-side step.
 * Doing INCR then EXPIRE as two commands could leave a key with no TTL if the
 * connection dropped in between, locking that IP out permanently. The PTTL < 0
 * branch also repairs any key that was left without an expiry.
 * Returns { count, ttlMs }.
 */
const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

// In-memory fallback map: key -> { count, resetTime }
const memoryStore = new Map();

// Periodic cleanup of expired memory entries every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, data] of memoryStore.entries()) {
    if (data.resetTime <= now) {
      memoryStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Prevent the interval from keeping the event loop alive during unit tests
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

/**
 * Enterprise Rate Limiter Factory
 * Protects against brute-force attacks and credential stuffing
 *
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds (default: 15 mins)
 * @param {number} options.max - Maximum allowed attempts within window (default: 10)
 * @param {string} options.prefix - Storage key prefix
 * @param {string} options.message - Human-readable rejection message
 */
export function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 10,
  prefix = 'rl',
  message = 'Too many attempts. Please try again later.',
} = {}) {
  const windowSec = Math.ceil(windowMs / 1000);

  return async (req, res, next) => {
    // req.ip honours app.set('trust proxy', TRUST_PROXY): X-Forwarded-For is only
    // believed when it was added by a proxy we trust. Reading the header directly let
    // any client pick a fresh "IP" per request and skip the limit entirely.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const key = `ratelimit:${prefix}:${ip}`;
    const client = getRedisClient();

    // 1. Primary path: Redis
    if (client && client.isOpen) {
      try {
        const [current, ttlMs] = await client.eval(RATE_LIMIT_SCRIPT, {
          keys: [key],
          arguments: [String(windowSec * 1000)],
        });
        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));
        res.setHeader('X-RateLimit-Reset', Date.now() + (ttlMs > 0 ? ttlMs : windowMs));

        if (current > max) {
          return errorResponse(res, {
            statusCode: 429,
            message,
          });
        }

        return next();
      } catch (err) {
        console.warn(`⚠️ [RateLimiter] Redis error, gracefully falling back to memory store: ${err.message}`);
      }
    }

    // 2. Resilient fallback: In-memory store
    const now = Date.now();
    let record = memoryStore.get(key);

    if (!record || record.resetTime <= now) {
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      memoryStore.set(key, record);
    } else {
      record.count += 1;
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - record.count));
    res.setHeader('X-RateLimit-Reset', record.resetTime);

    if (record.count > max) {
      return errorResponse(res, {
        statusCode: 429,
        message,
      });
    }

    next();
  };
}

/**
 * Authentication Route Limiter: Max 10 attempts per 15 minutes per IP
 */
export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: 'auth',
  message: 'Too many authentication attempts. Please try again after 15 minutes.',
});
