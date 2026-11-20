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
 */

const MAX_BACKOFF_MS = 5000;
const DEFAULT_BOOT_WAIT_MS = 10000;

let redisClient = null;
let connectPromise = null;

function reconnectStrategy(retries) {
  // 100ms, 200ms, 400ms ... capped at 5s, forever
  return Math.min(100 * 2 ** Math.min(retries, 10), MAX_BACKOFF_MS);
}

function buildClient(name) {
  const client = createClient({
    url: config.redis.url,
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

function attachLogging(client, label) {
  let wasReady = false;
  let outageLogged = false;

  client.on('ready', () => {
    if (!wasReady) {
      console.log(`⚡ [Redis:${label}] Ready on ${config.redis.url}`);
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
 * True only when the shared client can execute commands right now.
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
  const client = getRedisClient();

  if (!connectPromise && !client.isOpen) {
    connectPromise = client.connect().catch((err) => {
      // Only reached if the client is explicitly closed while connecting
      console.warn(`⚠️  [Redis] Connect aborted: ${err.message}`);
    });
  }

  if (!client.isReady && connectPromise) {
    let timer;
    await Promise.race([
      connectPromise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  if (!client.isReady) {
    console.warn(
      `⚠️  [Redis] Not reachable at ${config.redis.url} after ${waitMs}ms. ` +
        'Starting anyway — will connect automatically when Redis comes up.'
    );
  }

  return client;
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
  attachLogging(client, name);
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
 * Disconnect the shared client gracefully.
 */
export async function disconnectRedis() {
  if (redisClient) {
    await closeClient(redisClient);
    connectPromise = null;
    console.log('⚡ [Redis] Disconnected gracefully.');
  }
}
