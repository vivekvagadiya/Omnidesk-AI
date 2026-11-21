import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded regardless of process CWD
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT, 10),
  nodeEnv: process.env.NODE_ENV,
  clientUrl: process.env.CLIENT_URL,

  // Database configurations
  mongodb: {
    uri: process.env.MONGODB_URI,
  },
  redis: {
    // State Redis: chat sessions, HITL action tokens, rate limits, notification queue
    // (noeviction + AOF persistence)
    url: process.env.REDIS_URL,
    // Cache Redis: route-level HTTP response cache (allkeys-lru, no persistence).
    // Falls back to the state Redis when unset.
    cacheUrl: process.env.REDIS_CACHE_URL || process.env.REDIS_URL,
  },

  // Number of reverse proxies in front of the API (0 = direct, 1 = nginx/ALB...).
  // Decides whether X-Forwarded-For is trusted for req.ip (rate limiting).
  trustProxy: parseInt(process.env.TRUST_PROXY || '0', 10),
  qdrant: {
    url: process.env.QDRANT_URL,
  },

  // Auth & Dual JWT Tokens
  jwt: {
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN,
  },

  // AI & External APIs
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },
};
