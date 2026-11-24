import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded regardless of process CWD
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config();

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

// Fail fast in production if required environment configuration is missing
if (isProduction) {
  const missing = [];
  if (!process.env.REDIS_URL) missing.push("REDIS_URL");
  if (!process.env.MONGODB_URI) missing.push("MONGODB_URI");
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");

  if (missing.length > 0) {
    throw new Error(
      `[Config] Missing required production environment variables: ${missing.join(", ")}`,
    );
  }
}

export const config = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv,
  clientUrl: process.env.CLIENT_URL,

  // Database configurations
  mongodb: {
    uri: process.env.MONGODB_URI,
  },
  redis: {
    url: process.env.REDIS_URL,
    cacheUrl: process.env.REDIS_CACHE_URL || null,
  },

  trustProxy: parseInt(process.env.TRUST_PROXY || "0", 10),
  qdrant: {
    url: process.env.QDRANT_URL,
  },

  auth: {
    allowOfflineFallback:
      !isProduction &&
      (process.env.ALLOW_OFFLINE_AUTH === "true" || nodeEnv === "test"),
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN,
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    primaryModel: process.env.GEMINI_PRIMARY_MODEL || 'gemini-3.8-flash',
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash',
  },
};
