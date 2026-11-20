import { Router } from 'express';
import mongoose from 'mongoose';
import { getRedisClient, isRedisReady } from '../config/redis.js';
import { cacheStats } from '../services/cache/cache.service.js';

const router = Router();

router.get('/', async (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';

  let redisStatus = 'disconnected';
  let redisLatencyMs = null;
  if (isRedisReady()) {
    try {
      const started = Date.now();
      await getRedisClient().ping();
      redisLatencyMs = Date.now() - started;
      redisStatus = 'connected';
    } catch {
      redisStatus = 'error';
    }
  } else if (getRedisClient().isOpen) {
    redisStatus = 'reconnecting';
  }

  const lookups = cacheStats.hits + cacheStats.misses;

  res.json({
    status: mongoStatus === 'connected' && redisStatus === 'connected' ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    service: 'OmniDesk AI Backend API',
    version: '1.0.0',
    databases: {
      mongodb: mongoStatus,
      redis: redisStatus,
    },
    cache: {
      ...cacheStats,
      hitRate: lookups ? Number((cacheStats.hits / lookups).toFixed(3)) : null,
      redisLatencyMs,
    },
    uptime: `${Math.floor(process.uptime())}s`,
  });
});

export default router;
