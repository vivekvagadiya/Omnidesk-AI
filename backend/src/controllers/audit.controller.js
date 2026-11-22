import { AuditLog } from '../models/AuditLog.model.js';
import { verifyAuditChain } from '../services/audit/audit.service.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';

/**
 * Controller: List Audit Logs with SHA-256 signatures & telemetry
 * GET /api/audit-logs
 */
export async function getAuditLogs(req, res) {
  const user = req.user;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Unauthorized: Valid user credentials required.',
    });
  }

  const { action, actorId, page = 1, limit = 20 } = req.query;

  const query = {
    orgId: user.orgId,
  };

  if (action) {
    query.action = new RegExp(action.trim(), 'i');
  }

  if (actorId) {
    query.actorId = actorId.trim();
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  try {
    let logs = [];
    let total = 0;

    if (typeof AuditLog.find === 'function') {
      const q = AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum);
      logs = typeof q.lean === 'function' ? await q.lean() : await q;
      total = typeof AuditLog.countDocuments === 'function' ? await AuditLog.countDocuments(query) : logs.length;
    }

    return successResponse(res, {
      statusCode: 200,
      message: 'Audit logs retrieved successfully.',
      data: {
        logs: logs || [],
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: total || 0,
          totalPages: Math.ceil(total / limitNum) || 1,
        },
      },
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Failed to retrieve audit logs.',
    });
  }
}

/**
 * Controller: Verify SHA-256 Cryptographic Chain
 * GET /api/audit-logs/verify
 */
export async function getAuditVerification(req, res) {
  const user = req.user;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Unauthorized: Valid user credentials required.',
    });
  }

  try {
    const verification = await verifyAuditChain(user.orgId);
    return successResponse(res, {
      statusCode: 200,
      message: verification.verified
        ? 'Audit log cryptographic chain verified successfully (SHA-256 unbroken).'
        : 'Audit log integrity violation detected.',
      data: verification,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Failed to verify audit log chain.',
    });
  }
}
