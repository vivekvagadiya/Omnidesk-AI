import * as assetService from '../services/asset.service.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';

// Exported so route-level middlewares and consumers maintain seamless compatibility
export const ASSET_ADMIN_ROLES = assetService.ASSET_ADMIN_ROLES;

/**
 * Controller: List Hardware Assets (Thin Controller)
 * Pure Controller Logic (Delegates to asset.service.js)
 * GET /api/assets
 */
export async function getAssets(req, res, next) {
  try {
    const { status, type, assignedTo, page, limit } = req.query;

    const data = await assetService.getAssetsService({
      user: req.user,
      status,
      type,
      assignedTo,
      page,
      limit,
    });

    return successResponse(res, {
      statusCode: 200,
      message: 'Assets retrieved successfully.',
      data,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: err.statusCode || 500,
      message: err.message || 'Failed to retrieve assets.',
    });
  }
}

/**
 * Controller: Get Single Asset by Tag (Thin Controller)
 * Pure Controller Logic (Delegates to asset.service.js)
 * GET /api/assets/:assetTag
 */
export async function getAssetByTag(req, res, next) {
  try {
    const { assetTag } = req.params;

    const asset = await assetService.getAssetByTagService({
      user: req.user,
      assetTag,
    });

    return successResponse(res, {
      statusCode: 200,
      message: 'Asset retrieved successfully.',
      data: asset,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: err.statusCode || 500,
      message: err.message || 'Failed to retrieve asset.',
    });
  }
}

/**
 * Controller: Update Asset Assignment or Status (Thin Controller)
 * Pure Controller Logic (Delegates to asset.service.js)
 * PATCH /api/assets/:assetTag
 */
export async function updateAsset(req, res, next) {
  try {
    const { assetTag } = req.params;

    const updated = await assetService.updateAssetService({
      user: req.user,
      assetTag,
      updateData: req.body,
    });

    return successResponse(res, {
      statusCode: 200,
      message: `Asset ${assetTag} updated successfully.`,
      data: updated,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: err.statusCode || 500,
      message: err.message || 'Failed to update asset.',
    });
  }
}
