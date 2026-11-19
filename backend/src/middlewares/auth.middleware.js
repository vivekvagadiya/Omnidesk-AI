import { verifyToken } from '../utils/jwt.js';
import { User } from '../models/User.model.js';
import { errorResponse } from '../utils/apiResponse.js';

/**
 * Middleware to authenticate requests via Bearer JWT
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
    const decoded = verifyToken(token);

    // Optional fast-path: if User model is connected, attach full user; else attach decoded payload
    req.user = decoded;

    // If needed, verify active status in database
    if (User.db?.readyState === 1) {
      const user = await User.findOne({ userId: decoded.userId });
      if (!user || user.status !== 'ACTIVE') {
        return errorResponse(res, {
          statusCode: 401,
          message: 'User account is inactive or not found.',
        });
      }
      req.userDoc = user;
    }

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
