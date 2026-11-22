import * as profileService from '../services/profile.service.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';

/**
 * Controller: Get Leave Balance & Quotas (Thin Controller)
 * Supports caller's own balance or specified ?userId for Admins and Managers.
 * Pure Controller Logic (Delegates to profile.service.js; caching handled by route-level cacheResponse middleware)
 * GET /api/profile/balance
 */
export async function getLeaveBalance(req, res, next) {
  try {
    const data = await profileService.getLeaveBalanceService({
      user: req.user,
      requestedUserId: req.query?.userId,
    });

    return successResponse(res, {
      statusCode: 200,
      message: 'Leave quota balance retrieved successfully.',
      data,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: err.statusCode || 500,
      message: err.message || 'Failed to retrieve leave balance.',
    });
  }
}
