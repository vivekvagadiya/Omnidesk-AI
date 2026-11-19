import { Router } from 'express';
import mongoose from 'mongoose';
import { getRedisClient } from '../config/redis.js';

const router = Router();

router.get('/', async (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const redisClient = getRedisClient();
  const redisStatus = redisClient.isOpen ? 'connected' : 'disconnected';

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'OmniDesk AI Backend API',
    version: '1.0.0',
    databases: {
      mongodb: mongoStatus,
      redis: redisStatus,
    },
    uptime: `${Math.floor(process.uptime())}s`,
  });
});

export default router;
