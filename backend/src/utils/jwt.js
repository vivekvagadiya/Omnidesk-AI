import jwt from 'jsonwebtoken';
import { config } from '../config/environment.js';

/**
 * Generate a signed JWT token with standard claims
 *
 * @param {Object} payload { userId, email, role, orgId, managerId }
 * @param {string} [expiresIn] Token expiration string (e.g. '7d', '1h')
 * @returns {string} Signed JWT string
 */
export function generateToken(payload, expiresIn = config.jwt.expiresIn) {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn,
    issuer: 'omnidesk-api',
  });
}

/**
 * Verify a JWT token
 *
 * @param {string} token Bearer token string
 * @returns {Object} Decoded payload
 */
export function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret, {
    issuer: 'omnidesk-api',
  });
}
