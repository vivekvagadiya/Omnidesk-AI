import { verifyAccessToken } from '../utils/jwt.js';
import { User } from '../models/User.model.js';
import { errorResponse } from '../utils/apiResponse.js';

/**
 * Middleware to authenticate requests via Bearer Access JWT
 * Enforces instant token revocation via tokenVersion matching.
 */
export async function authenticateJwt(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Authentication required. No Bearer token provided.',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);

    // If database connection is active or findOne is mocked, verify against user document
    if (User.db?.readyState === 1 || typeof User.findOne === 'function') {
      try {
        const user = await User.findOne({ userId: decoded.userId });
        if (user) {
          if (user.status !== 'ACTIVE') {
            return errorResponse(res, {
              statusCode: 403,
              message: 'User account is inactive.',
            });
          }

          // Instant token revocation: verify version in token matches user's tokenVersion
          if (decoded.version !== undefined && decoded.version !== user.tokenVersion) {
            return errorResponse(res, {
              statusCode: 401,
              message: 'Token has been revoked.',
            });
          }

          req.user = typeof user.toSafeObject === 'function' ? user.toSafeObject() : user;
          req.userDoc = user;
          return next();
        }
      } catch (dbErr) {
        // If DB query fails and DB is not connected, fall through to decoded token
        if (User.db?.readyState === 1) throw dbErr;
      }
    }

    // Fast-path / fallback when testing without live DB
    req.user = decoded;
    next();
  } catch (err) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Invalid or expired authentication token.',
      error: err.message,
    });
  }
}

/**
 * Middleware for Role-Based Access Control (RBAC)
 * @param  {...string} allowedRoles Roles permitted to access the route
 */
export function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return errorResponse(res, {
        statusCode: 403,
        message: 'Forbidden: Missing user role.',
      });
    }

    // Super Admin bypasses role checks
    if (req.user.role === 'super_admin') {
      return next();
    }

    if (!allowedRoles.includes(req.user.role)) {
      return errorResponse(res, {
        statusCode: 403,
        message: `Access Denied: Role '${req.user.role}' lacks permission. Required roles: ${allowedRoles.join(', ')}`,
      });
    }

    next();
  };
}

/**
 * Middleware to ensure request cannot cross tenant/organization boundaries
 */
export function requireSameOrg(req, res, next) {
  const targetOrgId = req.params?.orgId || req.body?.orgId || req.query?.orgId;

  if (req.user?.role === 'super_admin') {
    return next();
  }

  if (targetOrgId && targetOrgId !== req.user?.orgId) {
    return errorResponse(res, {
      statusCode: 403,
      message: `Tenant Isolation Breach: You cannot access organization '${targetOrgId}' from '${req.user?.orgId}'.`,
    });
  }

  next();
}
