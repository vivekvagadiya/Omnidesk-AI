import jwt from 'jsonwebtoken';
import { config } from '../config/environment.js';

/**
 * Generate a short-lived Access Token (15 minutes)
 * Includes user identity, permissions, and tokenVersion for instant revocation
 */
export function generateAccessToken(payload) {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.accessExpiresIn,
    issuer: 'omnidesk-api',
  });
}

/**
 * Generate a long-lived Refresh Token (7 days)
 * Used exclusively at /api/auth/refresh to mint fresh access tokens
 */
export function generateRefreshToken(payload) {
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
    issuer: 'omnidesk-api',
  });
}

/**
 * Mint both Access and Refresh tokens for an authenticated user
 */
export function generateTokens(user) {
  const tokenPayload = {
    userId: user.userId,
    name: user.name,
    email: user.email,
    role: user.role,
    orgId: user.orgId,
    department: user.department,
    managerId: user.managerId,
    version: user.tokenVersion || 0,
  };

  const accessToken = generateAccessToken(tokenPayload);

  const refreshToken = generateRefreshToken({
    userId: user.userId,
    version: user.tokenVersion || 0,
  });

  return { accessToken, refreshToken };
}

/**
 * Verify Access Token
 */
export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.secret, {
    issuer: 'omnidesk-api',
  });
}

/**
 * Verify Refresh Token
 */
export function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret, {
    issuer: 'omnidesk-api',
  });
}

// Backwards-compatible aliases
export const generateToken = (payload, expiresIn) => {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: expiresIn || config.jwt.accessExpiresIn,
    issuer: 'omnidesk-api',
  });
};

export const verifyToken = verifyAccessToken;
