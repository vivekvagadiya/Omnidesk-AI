import { Asset, ASSET_TYPES, ASSET_STATUSES } from '../models/Asset.model.js';
import { User } from '../models/User.model.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';

export const ASSET_ADMIN_ROLES = ['super_admin', 'org_admin', 'it_admin'];

/**
 * Controller: List Hardware Assets
 * GET /api/assets
 */
export async function getAssets(req, res) {
  const user = req.user;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Unauthorized: Valid user credentials required.',
    });
  }

  const { status, type, assignedTo, page = 1, limit = 20 } = req.query;

  const query = {
    orgId: user.orgId,
  };

  const isAssetAdmin = ASSET_ADMIN_ROLES.includes(user.role);

  if (isAssetAdmin) {
    if (assignedTo) query.assignedTo = assignedTo.trim();
  } else if (user.role === 'manager') {
    // Managers can view their own and their team's assigned assets, plus in-stock assets
    const reports = await User.find({ orgId: user.orgId, managerId: user.userId }).select('userId').lean();
    const team = [user.userId, ...reports.map((r) => r.userId)];
    if (assignedTo) {
      if (team.includes(assignedTo.trim())) {
        query.assignedTo = assignedTo.trim();
      } else {
        return errorResponse(res, {
          statusCode: 403,
          message: 'Managers can only view assets assigned to their direct reports.',
        });
      }
    } else {
      query.$or = [{ assignedTo: { $in: team } }, { status: 'IN_STOCK' }];
    }
  } else {
    // Employees can only view assets assigned to them
    query.assignedTo = user.userId;
  }

  if (status && ASSET_STATUSES.includes(status.toUpperCase())) {
    query.status = status.toUpperCase();
  }

  if (type && ASSET_TYPES.includes(type.toUpperCase())) {
    query.type = type.toUpperCase();
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  try {
    let assets = [];
    let total = 0;

    if (typeof Asset.find === 'function') {
      const execQuery = Asset.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum);
      assets = typeof execQuery.lean === 'function' ? await execQuery.lean() : await execQuery;
      total = typeof Asset.countDocuments === 'function' ? await Asset.countDocuments(query) : assets.length;
    }

    return successResponse(res, {
      statusCode: 200,
      message: 'Assets retrieved successfully.',
      data: {
        assets: assets || [],
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
      message: err.message || 'Failed to retrieve assets.',
    });
  }
}

/**
 * Controller: Get Single Asset by Tag
 * GET /api/assets/:assetTag
 */
export async function getAssetByTag(req, res) {
  const user = req.user;
  const { assetTag } = req.params;

  if (!assetTag) {
    return errorResponse(res, {
      statusCode: 400,
      message: 'Parameter assetTag is required.',
    });
  }

  try {
    let asset = null;
    if (typeof Asset.findOne === 'function') {
      const query = Asset.findOne({ assetTag: assetTag.trim(), orgId: user.orgId });
      asset = typeof query.lean === 'function' ? await query.lean() : await query;
    }

    if (!asset) {
      return errorResponse(res, {
        statusCode: 404,
        message: `Asset '${assetTag}' not found.`,
      });
    }

    // Role check: Non-admins can only inspect their own assets
    const isAssetAdmin = ASSET_ADMIN_ROLES.includes(user.role);
    if (!isAssetAdmin && asset.assignedTo !== user.userId) {
      if (user.role === 'manager') {
        const report = await User.findOne({
          orgId: user.orgId,
          userId: asset.assignedTo,
          managerId: user.userId,
        }).select('userId').lean();
        if (!report && asset.status !== 'IN_STOCK') {
          return errorResponse(res, {
            statusCode: 403,
            message: 'Access denied: Asset is not assigned to your team.',
          });
        }
      } else {
        return errorResponse(res, {
          statusCode: 403,
          message: 'Access denied: You can only view assets assigned to you.',
        });
      }
    }

    return successResponse(res, {
      statusCode: 200,
      message: 'Asset retrieved successfully.',
      data: asset,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Failed to retrieve asset.',
    });
  }
}

/**
 * Controller: Update Asset Assignment or Status (IT Admin only)
 * PATCH /api/assets/:assetTag
 */
export async function updateAsset(req, res) {
  const user = req.user;
  const { assetTag } = req.params;
  const { status, assignedTo, model, cost } = req.body;

  const isAssetAdmin = ASSET_ADMIN_ROLES.includes(user.role);
  if (!isAssetAdmin) {
    return errorResponse(res, {
      statusCode: 403,
      message: 'Access Denied: Only IT Admins and Org Admins can update hardware assets.',
    });
  }

  const updateFields = {};
  if (status && ASSET_STATUSES.includes(status.toUpperCase())) {
    updateFields.status = status.toUpperCase();
  }
  if (assignedTo !== undefined) {
    updateFields.assignedTo = assignedTo ? assignedTo.trim() : null;
  }
  if (model && typeof model === 'string') {
    updateFields.model = model.trim();
  }
  if (cost !== undefined && !isNaN(Number(cost))) {
    updateFields.cost = Number(cost);
  }

  try {
    const updated = await Asset.findOneAndUpdate(
      { assetTag: assetTag.trim(), orgId: user.orgId },
      { $set: updateFields },
      { new: true }
    );

    if (!updated) {
      return errorResponse(res, {
        statusCode: 404,
        message: `Asset '${assetTag}' not found in this organization.`,
      });
    }

    return successResponse(res, {
      statusCode: 200,
      message: `Asset ${assetTag} updated successfully.`,
      data: updated,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Failed to update asset.',
    });
  }
}
