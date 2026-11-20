import { Router } from 'express';
import { getLeaveBalance } from '../controllers/profile.controller.js';
import { authenticateJwt } from '../middlewares/auth.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';
import { CACHE_TTL } from '../services/cache/cache.service.js';

const router = Router();

// Enforce JWT authentication on all profile routes
router.use(authenticateJwt);

/**
 * @route   GET /api/profile/balance
 * @desc    Get authenticated employee's leave balance & quota
 * @access  Private (All Roles)
 * @cache   5-minute TTL per tenant user (Route-Level Declarative Middleware)
 */
router.get(
  '/balance',
  cacheResponse({ ttl: CACHE_TTL.BALANCE, tag: 'balance', scope: 'user' }),
  getLeaveBalance
);

export default router;
