import { createClient } from 'redis';
import { config } from './environment.js';

let redisClient = null;
let isConnected = false;

/**
 * Get or initialize the singleton Redis client
 */
export function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({
      url: config.redis.url,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 5) {
            console.warn('⚠️  [Redis] Max reconnect retries reached. Failing open.');
            return false;
          }
          return Math.min(retries * 500, 2000);
        },
      },
    });

    redisClient.on('connect', () => {
      isConnected = true;
      console.log(`⚡ [Redis] Connected successfully to ${config.redis.url}`);
    });

    redisClient.on('error', (err) => {
      console.error('⚡ [Redis] Error:', err.message);
      isConnected = false;
    });

    redisClient.on('end', () => {
      isConnected = false;
      console.warn('⚡ [Redis] Connection closed.');
    });
  }

  return redisClient;
}

/**
 * Connect to Redis
 */
export async function connectRedis() {
  const client = getRedisClient();
  if (!client.isOpen) {
    try {
      await client.connect();
    } catch (error) {
      console.warn(`⚠️  [Redis] Could not connect to Redis at ${config.redis.url}: ${error.message}`);
    }
  }
  return client;
}

/**
 * Disconnect Redis gracefully
 */
export async function disconnectRedis() {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    isConnected = false;
    console.log('⚡ [Redis] Disconnected gracefully.');
  }
}
