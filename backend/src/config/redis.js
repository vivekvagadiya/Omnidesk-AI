import { createClient } from 'redis';
import { config } from './environment.js';

/**
 * Omnidesk-AI Redis Connection Manager
 *
 * Maintainable, direct connection management without unnecessary abstraction:
 *  - Single unified client for all operations by default.
 *  - Separate cache client only instantiated when REDIS_CACHE_URL is explicitly configured to a different endpoint.
 *  - Reconnection: Exponential backoff (100ms -> 5s max), retries continuously in background.
 *  - Readiness: isRedisReady() checks both socket connection and successful handshake.
 *  - Fast failure: disableOfflineQueue prevents hanging requests when Redis is unavailable.
 *  - Fail-safe credentials: Never logs credentials or auth tokens in logs.
 *  - Graceful shutdown: Cleanly closes connections on SIGINT/SIGTERM.
 */

const MAX_BACKOFF_MS = 5000;
const DEFAULT_BOOT_WAIT_MS = 10000;

let redisClient = null;
let cacheClient = null;

/**
 * Safely redact credentials from Redis URL for logging
 *
 * @param {string} rawUrl
 * @returns {string} Sanitized URL
 */
export function redactUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return String(rawUrl).replace(/\/\/[^@/]*@/, '//***@');
  }
}

function reconnectStrategy(retries) {
  // 100ms, 200ms, 400ms ... capped at 5s, retries forever
  return Math.min(100 * 2 ** Math.min(retries, 10), MAX_BACKOFF_MS);
}

function buildClient(name, url) {
  const client = createClient({
    url,
    name,
    disableOfflineQueue: true,
    pingInterval: 30000,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy,
    },
  });

  client.on('error', (err) => {
    if (!client._errorLogged) {
      console.warn(`⚠️  [Redis:${name}] Connection notice: ${err.message}. Retrying in background...`);
      client._errorLogged = true;
    }
  });

  client.on('ready', () => {
    console.log(`⚡ [Redis:${name}] Ready on ${redactUrl(url)}`);
    client._errorLogged = false;
  });

  return client;
}

/**
 * Shared Redis client for state (chat sessions, HITL tokens, rate limits)
 * and cache (when REDIS_CACHE_URL is not separated).
 */
export function getRedisClient() {
  if (!redisClient) {
    redisClient = buildClient('main', config.redis.url);
  }
  return redisClient;
}

/**
 * Cache Redis client. Returns the main client unless an explicit, distinct
 * REDIS_CACHE_URL is configured.
 */
export function getCacheClient() {
  if (!config.redis.cacheUrl || config.redis.cacheUrl === config.redis.url) {
    return getRedisClient();
  }
  if (!cacheClient) {
    cacheClient = buildClient('cache', config.redis.cacheUrl);
  }
  return cacheClient;
}

/**
 * Check if a Redis client is connected and ready to execute commands
 */
export function isRedisReady(client = getRedisClient()) {
  return Boolean(client && client.isReady);
}

/**
 * Dedicated client factory for blocking commands (e.g. BRPOP, SUBSCRIBE)
 * to avoid stalling shared client operations.
 */
export function createDedicatedClient(name) {
  const client = buildClient(name, config.redis.url);
  client.connect().catch(() => {});
  return client;
}

/**
 * Helper to safely close a client
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
      // Already closed
    }
  }
}

/**
 * Initialize connection(s) at application startup.
 * Waits up to waitMs for connections to become ready; continues in background if Redis is still starting.
 */
export async function connectRedis({ waitMs = DEFAULT_BOOT_WAIT_MS } = {}) {
  const clients = [getRedisClient()];
  if (config.redis.cacheUrl && config.redis.cacheUrl !== config.redis.url) {
    clients.push(getCacheClient());
  }

  const connectTasks = clients.map(async (client) => {
    if (!client.isOpen) {
      client.connect().catch(() => {});
    }
    if (client.isReady) return;

    await new Promise((resolve) => {
      let timer;
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onTimeout = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        client.off('ready', onReady);
      };
      timer = setTimeout(onTimeout, waitMs);
      client.once('ready', onReady);
    });
  });

  await Promise.all(connectTasks);

  if (!getRedisClient().isReady) {
    console.warn(
      `⚠️  [Redis] Main client not yet ready on ${redactUrl(config.redis.url)} (waited ${waitMs}ms). ` +
        'Continuing startup — client will connect automatically once Redis is online.'
    );
  }

  return getRedisClient();
}

/**
 * Disconnect all active Redis clients cleanly
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
}
