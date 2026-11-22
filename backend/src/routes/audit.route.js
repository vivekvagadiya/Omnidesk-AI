import { Router } from 'express';
import { getAuditLogs } from '../controllers/audit.controller.js';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware.js';

const router = Router();

// Enforce JWT authentication on all audit log routes
router.use(authenticateJwt);

/**
 * @route   GET /api/audit-logs
 * @desc    List corporate audit logs with telemetry
 * @access  Private (Admins, Managers & Employees)
 */
router.get(
  '/',
  requireRoles('super_admin', 'org_admin', 'hr_admin', 'it_admin', 'manager', 'employee'),
  getAuditLogs
);

export default router;
