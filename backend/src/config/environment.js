import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded regardless of process CWD
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '5001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL,

  // Database configurations
  mongodb: {
    uri: process.env.MONGODB_URI,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  qdrant: {
    url: process.env.QDRANT_URL,
  },

  // Auth & Dual JWT Tokens
  jwt: {
    secret: process.env.JWT_SECRET || 'omnidesk-enterprise-access-token-secret-2026',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'omnidesk-enterprise-refresh-token-secret-2026',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  // AI & External APIs
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },
};
