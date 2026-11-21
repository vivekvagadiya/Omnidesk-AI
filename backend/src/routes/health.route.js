import { Router } from 'express';
import mongoose from 'mongoose';
import { getRedisClient, getCacheClient, isRedisReady } from '../config/redis.js';
import { cacheStats } from '../services/cache/cache.service.js';

const router = Router();

router.get('/', async (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';

  async function probe(client) {
    if (isRedisReady(client)) {
      try {
        const started = Date.now();
        await client.ping();
        return { status: 'connected', latencyMs: Date.now() - started };
      } catch {
        return { status: 'error', latencyMs: null };
      }
    }
    return { status: client.isOpen ? 'reconnecting' : 'disconnected', latencyMs: null };
  }

  const state = await probe(getRedisClient());
  const cache = getCacheClient() === getRedisClient() ? state : await probe(getCacheClient());

  const lookups = cacheStats.hits + cacheStats.misses;

  res.json({
    status: mongoStatus === 'connected' && state.status === 'connected' && cache.status === 'connected' ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    service: 'OmniDesk AI Backend API',
    version: '1.0.0',
    databases: {
      mongodb: mongoStatus,
      redis: state.status,
      redisCache: cache.status,
    },
    cache: {
      ...cacheStats,
      hitRate: lookups ? Number((cacheStats.hits / lookups).toFixed(3)) : null,
      redisLatencyMs: cache.latencyMs,
    },
    uptime: `${Math.floor(process.uptime())}s`,
  });
});

export default router;
