import { createClient } from 'redis';
import { config } from './environment.js';

/**
 * Redis Connection Manager
 *
 * Design rules:
 *  1. Never give up reconnecting. Redis (Docker Desktop on Windows especially) often
 *     comes up after the API, or restarts. The old strategy stopped after 5 retries,
 *     leaving the app silently on in-memory fallbacks forever.
 *  2. Fail fast while disconnected (disableOfflineQueue). Commands issued during an
 *     outage reject immediately so callers fall back (cache = MISS) instead of hanging.
 *  3. Callers check `isRedisReady()` (socket connected AND handshake done), not `isOpen`
 *     (which is also true while reconnecting).
 *  4. Blocking commands (BRPOP) get their own connection via `createDedicatedClient()`,
 *     because a blocking call on the shared client stalls every other command on it.
 *  5. Two roles, two instances:
 *       state (REDIS_URL)       sessions, HITL tokens, rate limits, queue — must never be evicted
 *       cache (REDIS_CACHE_URL) HTTP response cache — evicts LRU when full, safe to lose
 *     When REDIS_CACHE_URL is unset, the cache shares the state connection.
 */

const MAX_BACKOFF_MS = 5000;
const DEFAULT_BOOT_WAIT_MS = 10000;

let redisClient = null;
let cacheClient = null;
const connectPromises = new Map();

function reconnectStrategy(retries) {
  // 100ms, 200ms, 400ms ... capped at 5s, forever
  return Math.min(100 * 2 ** Math.min(retries, 10), MAX_BACKOFF_MS);
}

function buildClient(name, url = config.redis.url) {
  const client = createClient({
    url,
    name,
    disableOfflineQueue: true,
    pingInterval: 30000, // keeps idle connections alive through Docker/NAT and detects dead sockets
    socket: {
      connectTimeout: 5000,
      reconnectStrategy,
    },
  });
  return client;
}

function redactUrl(url) {
  return String(url || '').replace(/\/\/[^@/]*@/, '//***@');
}

function attachLogging(client, label, url = config.redis.url) {
  let wasReady = false;
  let outageLogged = false;

  client.on('ready', () => {
    if (!wasReady) {
      console.log(`⚡ [Redis:${label}] Ready on ${redactUrl(url)}`);
    } else {
      console.log(`⚡ [Redis:${label}] Reconnected — back on Redis.`);
    }
    wasReady = true;
    outageLogged = false;
  });

  // Log one line per outage instead of one per retry
  client.on('error', (err) => {
    if (!outageLogged) {
      console.warn(
        `⚠️  [Redis:${label}] ${err.message}. Retrying in the background; cache is bypassed until Redis is back.`
      );
      outageLogged = true;
    }
  });
}

/**
 * Shared client for normal (non-blocking) commands.
 */
export function getRedisClient() {
  if (!redisClient) {
    redisClient = buildClient('omnidesk-main');
    attachLogging(redisClient, 'main');
  }
  return redisClient;
}

/**
 * Client for the HTTP response cache (separate instance when REDIS_CACHE_URL is set).
 */
export function getCacheClient() {
  if (!config.redis.cacheUrl || config.redis.cacheUrl === config.redis.url) {
    return getRedisClient();
  }
  if (!cacheClient) {
    cacheClient = buildClient('omnidesk-cache', config.redis.cacheUrl);
    attachLogging(cacheClient, 'cache', config.redis.cacheUrl);
  }
  return cacheClient;
}

/**
 * True only when the given client (default: state) can execute commands right now.
 */
export function isRedisReady(client = getRedisClient()) {
  return Boolean(client && client.isReady);
}

/**
 * Start connecting. Resolves when Redis is ready or after `waitMs`, whichever is first.
 * The connection keeps retrying in the background either way, so the API can boot
 * before Redis and pick it up automatically once it starts.
 *
 * @param {Object} [options]
 * @param {number} [options.waitMs=10000]
 * @returns {Promise<import('redis').RedisClientType>}
 */
export async function connectRedis({ waitMs = DEFAULT_BOOT_WAIT_MS } = {}) {
  const clients = [getRedisClient(), getCacheClient()].filter((c, i, all) => all.indexOf(c) === i);

  for (const client of clients) {
    if (!connectPromises.has(client) && !client.isOpen) {
      connectPromises.set(
        client,
        client.connect().catch((err) => {
          // Only reached if the client is explicitly closed while connecting
          console.warn(`⚠️  [Redis] Connect aborted: ${err.message}`);
        })
      );
    }
  }

  const pending = clients.filter((c) => !c.isReady).map((c) => connectPromises.get(c));
  if (pending.length) {
    let timer;
    await Promise.race([
      Promise.all(pending),
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  if (!getRedisClient().isReady) {
    console.warn(
      `⚠️  [Redis] State Redis not reachable at ${redactUrl(config.redis.url)} after ${waitMs}ms. ` +
        'Starting anyway — will connect automatically when Redis comes up.'
    );
  }
  if (getCacheClient() !== getRedisClient() && !getCacheClient().isReady) {
    console.warn(`⚠️  [Redis] Cache Redis not reachable at ${redactUrl(config.redis.cacheUrl)} — responses served uncached until it is.`);
  }

  return getRedisClient();
}

/**
 * Create a separate connection for blocking commands (BRPOP, SUBSCRIBE...).
 * Connects in the background with the same never-give-up strategy.
 *
 * @param {string} name Connection label, e.g. 'worker'
 * @returns {import('redis').RedisClientType}
 */
export function createDedicatedClient(name) {
  const client = buildClient(`omnidesk-${name}`);
  attachLogging(client, name, config.redis.url);
  client.connect().catch(() => {
    /* closed while connecting — ignore */
  });
  return client;
}

/**
 * Close a client whether it is connected, reconnecting or never connected.
 */
export async function closeClient(client) {
  if (!client) return;
  try {
    if (client.isReady) {
      await client.quit();
    } else if (client.isOpen) {
      await client.disconnect();
    }
  } catch {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Disconnect state and cache clients gracefully.
 */
export async function disconnectRedis() {
  if (cacheClient) {
    await closeClient(cacheClient);
    cacheClient = null;
  }
  if (redisClient) {
    await closeClient(redisClient);
    redisClient = null;
    console.log('⚡ [Redis] Disconnected gracefully.');
  }
  connectPromises.clear();
}
