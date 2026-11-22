import { Router } from 'express';
import { getLeaveBalance } from '../controllers/profile.controller.js';
import { authenticateJwt } from '../middlewares/auth.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';
import { CACHE_TTL, cacheTags } from '../services/cache/cache.service.js';

const router = Router();

// Enforce JWT authentication on all profile routes
router.use(authenticateJwt);

/**
 * @route   GET /api/profile/balance
 * @desc    Get employee's leave balance & quota (supports ?userId for Admin/Manager)
 * @access  Private (All Roles for self; Managers for direct reports; Admins for org)
 * @cache   5-minute TTL per tenant user
 */
router.get(
  '/balance',
  cacheResponse({
    ttl: CACHE_TTL.BALANCE,
    tag: 'balance',
    scope: 'user',
    query: ['userId'],
    tags: (req) => [
      cacheTags.user('balance', req.user.orgId, req.query?.userId?.trim() || req.user.userId),
    ],
  }),
  getLeaveBalance
);

export default router;
