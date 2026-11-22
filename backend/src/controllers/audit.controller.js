import * as auditService from '../services/audit/audit.service.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';

/**
 * Controller: List Audit Logs with SHA-256 signatures & telemetry (Thin Controller)
 * Pure Controller Logic (Delegates to audit.service.js)
 * GET /api/audit-logs
 */
export async function getAuditLogs(req, res, next) {
  try {
    const user = req.user;
    if (!user || !user.orgId) {
      return errorResponse(res, {
        statusCode: 401,
        message: 'Unauthorized: Valid user credentials required.',
      });
    }

    const { action, actorId, page, limit } = req.query;

    const data = await auditService.getAuditLogsService({
      orgId: user.orgId,
      action,
      actorId,
      page,
      limit,
    });

    return successResponse(res, {
      statusCode: 200,
      message: 'Audit logs retrieved successfully.',
      data,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: err.statusCode || 500,
      message: err.message || 'Failed to retrieve audit logs.',
    });
  }
}
