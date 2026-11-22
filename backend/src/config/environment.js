import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded regardless of process CWD
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

// Fail fast in production if required environment configuration is missing
if (isProduction) {
  const missing = [];
  if (!process.env.REDIS_URL) missing.push('REDIS_URL');
  if (!process.env.MONGODB_URI) missing.push('MONGODB_URI');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');

  if (missing.length > 0) {
    throw new Error(
      `[Config] Missing required production environment variables: ${missing.join(', ')}`
    );
  }
}

export const config = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

  // Database configurations
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/omnidesk',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    cacheUrl: process.env.REDIS_CACHE_URL || null,
  },

  trustProxy: parseInt(process.env.TRUST_PROXY || '0', 10),
  qdrant: {
    url: process.env.QDRANT_URL,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev_secret_key_omnidesk_2026',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_key_omnidesk_2026',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },
};
