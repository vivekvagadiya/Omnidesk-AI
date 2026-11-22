import { Router } from 'express';
import { getAssets, getAssetByTag, updateAsset } from '../controllers/asset.controller.js';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware.js';

const router = Router();

// Enforce JWT authentication on all asset routes
router.use(authenticateJwt);

/**
 * @route   GET /api/assets
 * @desc    List hardware assets with filters (type, status, assignedTo)
 * @access  Private (All Roles; results scoped by role)
 */
router.get('/', getAssets);

/**
 * @route   GET /api/assets/:assetTag
 * @desc    Get detailed asset metadata by hardware tag
 * @access  Private (All Roles; authorization enforced by controller)
 */
router.get('/:assetTag', getAssetByTag);

/**
 * @route   PATCH /api/assets/:assetTag
 * @desc    Update hardware asset status, assignment, or specifications
 * @access  Private (IT Admin, Org Admin, Super Admin)
 */
router.patch(
  '/:assetTag',
  requireRoles('super_admin', 'org_admin', 'it_admin'),
  updateAsset
);

export default router;
