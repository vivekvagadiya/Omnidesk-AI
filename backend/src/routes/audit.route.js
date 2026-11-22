import { Router } from 'express';
import { getAuditLogs, getAuditVerification } from '../controllers/audit.controller.js';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware.js';

const router = Router();

// Enforce JWT authentication on all audit log routes
router.use(authenticateJwt);

/**
 * @route   GET /api/audit-logs/verify
 * @desc    Cryptographic SHA-256 audit chain verification
 * @access  Private (Admins & Managers)
 */
router.get(
  '/verify',
  requireRoles('super_admin', 'org_admin', 'hr_admin', 'it_admin', 'manager'),
  getAuditVerification
);

/**
 * @route   GET /api/audit-logs
 * @desc    List immutable cryptographic audit logs with telemetry
 * @access  Private (Admins & Managers)
 */
router.get(
  '/',
  requireRoles('super_admin', 'org_admin', 'hr_admin', 'it_admin', 'manager'),
  getAuditLogs
);

export default router;
