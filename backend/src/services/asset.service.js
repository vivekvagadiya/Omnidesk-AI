import { Asset, ASSET_TYPES, ASSET_STATUSES } from '../models/Asset.model.js';
import { User } from '../models/User.model.js';
import { recordAuditLog } from './audit/audit.service.js';

export const ASSET_ADMIN_ROLES = ['super_admin', 'org_admin', 'it_admin'];

export class AssetServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'AssetServiceError';
    this.statusCode = statusCode;
  }
}

/**
 * Service: List hardware assets scoped by tenant and user role
 */
export async function getAssetsService({ user, status, type, assignedTo, page = 1, limit = 20 }) {
  if (!user || !user.orgId) {
    throw new AssetServiceError('Unauthorized: Valid user credentials required.', 401);
  }

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
        throw new AssetServiceError(
          'Managers can only view assets assigned to their direct reports.',
          403
        );
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

  let assets = [];
  let total = 0;

  if (typeof Asset.find === 'function') {
    const execQuery = Asset.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum);
    assets = typeof execQuery.lean === 'function' ? await execQuery.lean() : await execQuery;
    total = typeof Asset.countDocuments === 'function' ? await Asset.countDocuments(query) : assets.length;
  }

  return {
    assets: assets || [],
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: total || 0,
      totalPages: Math.ceil(total / limitNum) || 1,
    },
  };
}

/**
 * Service: Retrieve single hardware asset by tag with access control
 */
export async function getAssetByTagService({ user, assetTag }) {
  if (!user || !user.orgId) {
    throw new AssetServiceError('Unauthorized: Valid user credentials required.', 401);
  }

  if (!assetTag || typeof assetTag !== 'string' || assetTag.trim().length === 0) {
    throw new AssetServiceError('Parameter assetTag is required.', 400);
  }

  let asset = null;
  if (typeof Asset.findOne === 'function') {
    const query = Asset.findOne({ assetTag: assetTag.trim(), orgId: user.orgId });
    asset = typeof query.lean === 'function' ? await query.lean() : await query;
  }

  if (!asset) {
    throw new AssetServiceError(`Asset '${assetTag}' not found.`, 404);
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
        throw new AssetServiceError(
          'Access denied: Asset is not assigned to your team.',
          403
        );
      }
    } else {
      throw new AssetServiceError(
        'Access denied: You can only view assets assigned to you.',
        403
      );
    }
  }

  return asset;
}

/**
 * Service: Update hardware asset specifications / assignment (IT Admin only)
 */
export async function updateAssetService({ user, assetTag, updateData }) {
  if (!user || !user.orgId) {
    throw new AssetServiceError('Unauthorized: Valid user credentials required.', 401);
  }

  const isAssetAdmin = ASSET_ADMIN_ROLES.includes(user.role);
  if (!isAssetAdmin) {
    throw new AssetServiceError(
      'Access Denied: Only IT Admins and Org Admins can update hardware assets.',
      403
    );
  }

  if (!assetTag || typeof assetTag !== 'string' || assetTag.trim().length === 0) {
    throw new AssetServiceError('Parameter assetTag is required.', 400);
  }

  const { status, assignedTo, model, cost } = updateData || {};

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

  const updated = await Asset.findOneAndUpdate(
    { assetTag: assetTag.trim(), orgId: user.orgId },
    { $set: updateFields },
    { new: true }
  );

  if (!updated) {
    throw new AssetServiceError(
      `Asset '${assetTag}' not found in this organization.`,
      404
    );
  }

  recordAuditLog({
    orgId: user.orgId,
    actor: {
      userId: user.userId,
      name: user.name || user.userId,
      role: user.role,
    },
    action: 'ASSET_UPDATED',
    entity: {
      type: 'asset',
      id: assetTag.trim(),
    },
    changes: {
      after: updateFields,
    },
  }).catch(() => {});

  return updated;
}
