import { Router } from 'express';
import { getLeaveBalance } from '../controllers/profile.controller.js';
import { authenticateJwt } from '../middlewares/auth.middleware.js';

const router = Router();

// Enforce JWT authentication on all profile routes
router.use(authenticateJwt);

/**
 * @route   GET /api/profile/balance
 * @desc    Get authenticated employee's leave balance & quota
 * @access  Private (All Roles)
 */
router.get('/balance', getLeaveBalance);

export default router;
