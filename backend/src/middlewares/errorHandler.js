import { config } from '../config/environment.js';

/**
 * Centralized Express Error Handler
 */
export function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || (res.statusCode >= 400 ? res.statusCode : 500);

  console.error(`💥 [Error] ${req.method} ${req.originalUrl}:`, err);

  const responsePayload = {
    success: false,
    message: err.message || 'Internal Server Error',
    error: config.nodeEnv === 'development' ? err.stack : undefined,
  };

  res.status(statusCode).json(responsePayload);
}
