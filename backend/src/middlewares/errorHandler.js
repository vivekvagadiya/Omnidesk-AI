import { config } from '../config/environment.js';

/**
 * Centralized Express Error Handler
 */
export function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || (res.statusCode >= 400 ? res.statusCode : 500);

  console.error(`💥 [Error] ${req.method} ${req.originalUrl}:`, err);

  let safeMessage = err.message || 'Internal Server Error';
  if (typeof safeMessage === 'string' && safeMessage.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(safeMessage.trim());
      if (parsed.error?.message) {
        safeMessage = parsed.error.message;
      }
    } catch {
      // not JSON
    }
  }

  // Prevent leaking Google GenAI / provider quota structures
  if (
    typeof safeMessage === 'string' &&
    (safeMessage.includes('quota') ||
      safeMessage.includes('generativelanguage.googleapis.com') ||
      safeMessage.includes('RESOURCE_EXHAUSTED'))
  ) {
    safeMessage = 'The AI service is currently experiencing high demand or quota limits. Please try again shortly.';
  }

  const responsePayload = {
    success: false,
    message: safeMessage,
    error: config.nodeEnv === 'development' ? err.stack : undefined,
  };

  res.status(statusCode).json(responsePayload);
}
