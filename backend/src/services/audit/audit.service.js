import { AuditLog } from '../../models/AuditLog.model.js';
import { User } from '../../models/User.model.js';

export const AUDIT_ADMIN_ROLES = ['super_admin', 'org_admin', 'hr_admin', 'it_admin'];

export class AuditServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'AuditServiceError';
    this.statusCode = statusCode;
  }
}

const SENSITIVE_KEY_REGEX = /^(password|token|refreshtoken|authorization|secret|apikey|access_token|id_token|cookie)$/i;

/**
 * Recursively strips sensitive keys such as passwords, tokens, and credentials
 * to ensure sensitive secrets are never stored in the audit log or exposed.
 *
 * @param {*} data
 * @returns {*} Sanitized data
 */
export function redactSensitiveData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      continue;
    }
    if (value && typeof value === 'object') {
      sanitized[key] = redactSensitiveData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Transforms an AuditLog document into a safe, role-scoped Data Transfer Object (DTO).
 * Redacts sensitive metadata or internal change details based on caller corporate privileges.
 *
 * @param {Object} log Raw audit document or plain object
 * @param {string} [role='employee'] Caller's corporate role
 * @returns {Object|null} Sanitized DTO
 */
export function toAuditLogDTO(log, role = 'employee') {
  if (!log) return null;

  const raw = typeof log.toObject === 'function' ? log.toObject() : log;
  const isAdmin = AUDIT_ADMIN_ROLES.includes(role);

  const actor = {
    userId: raw.actor?.userId || raw.actorId || '',
    name: raw.actor?.name || raw.actorName || '',
    role: raw.actor?.role || raw.actorRole || 'employee',
  };

  const entity = {
    type: raw.entity?.type || null,
    id: raw.entity?.id || raw.entityId || null,
  };

  let changes = null;
  if (raw.changes) {
    if (isAdmin) {
      changes = redactSensitiveData(raw.changes);
    } else {
      // Non-admins see high-level summary fields if present
      const after = raw.changes.after || raw.changes;
      changes = {
        after: {
          ...(after?.title && { title: after.title }),
          ...(after?.category && { category: after.category }),
          ...(after?.priority && { priority: after.priority }),
          ...(after?.status && { status: after.status }),
        },
      };
    }
  }

  const metadata = isAdmin && raw.metadata ? redactSensitiveData(raw.metadata) : {};
  const createdAt = raw.createdAt || raw.timestamp || new Date().toISOString();
  const idStr = raw._id ? raw._id.toString() : raw.logId || '';

  return {
    id: idStr,
    logId: idStr,
    orgId: raw.orgId,
    actor,
    // Flattened actor fields for UI backward-compatibility
    actorId: actor.userId,
    actorName: actor.name || actor.userId,
    actorRole: actor.role,
    action: raw.action,
    entity,
    entityId: entity.id,
    changes,
    metadata,
    createdAt,
    timestamp: createdAt,
  };
}

/**
 * Append an immutable audit log entry into MongoDB.
 * Strips any sensitive credentials before persisting.
 * Does not use fabricated telemetry, hash chains, or silent in-memory fallback.
 *
 * @param {Object} params
 * @param {string} params.orgId Organization ID (tenant)
 * @param {Object} [params.actor] Actor details { userId, name, role }
 * @param {string} [params.actorId] Fallback actor ID
 * @param {string} [params.actorName] Fallback actor name
 * @param {string} [params.actorRole] Fallback actor role
 * @param {string} params.action Audit action name
 * @param {Object} [params.entity] Entity details { type, id }
 * @param {string} [params.entityId] Fallback entity ID
 * @param {string} [params.entityType] Fallback entity type
 * @param {Object} [params.changes] Changes object { before, after }
 * @param {Object} [params.metadata] Network and request metadata { ipAddress, userAgent }
 * @param {Object} [params.payload] Legacy payload mapped to changes.after
 * @returns {Promise<Object>} Created AuditLog document
 */
export async function recordAuditLog({
  orgId,
  actor,
  actorId,
  actorName = '',
  actorRole = 'employee',
  action,
  entity,
  entityId,
  entityType,
  changes,
  metadata,
  payload,
}) {
  if (!orgId) {
    throw new AuditServiceError('Audit log requires orgId.', 400);
  }
  if (!action) {
    throw new AuditServiceError('Audit log requires action.', 400);
  }

  const resolvedActor = {
    userId: actor?.userId || actorId,
    name: actor?.name || actorName || '',
    role: actor?.role || actorRole || 'employee',
  };

  if (!resolvedActor.userId) {
    throw new AuditServiceError('Audit log requires actor userId.', 400);
  }

  const resolvedEntity = {
    type: entity?.type || entityType || null,
    id: entity?.id || entityId || null,
  };

  let resolvedChanges = null;
  if (changes) {
    resolvedChanges = {
      before: changes.before ? redactSensitiveData(changes.before) : null,
      after: changes.after ? redactSensitiveData(changes.after) : null,
    };
  } else if (payload && Object.keys(payload).length > 0) {
    resolvedChanges = {
      before: null,
      after: redactSensitiveData(payload),
    };
  }

  const resolvedMetadata = metadata ? redactSensitiveData(metadata) : {};

  const entry = {
    orgId: orgId.trim(),
    actor: resolvedActor,
    action: action.trim(),
    entity: resolvedEntity,
    changes: resolvedChanges,
    metadata: resolvedMetadata,
  };

  return await AuditLog.create(entry);
}

/**
 * Service: List Audit Logs with role-scoped access control & sanitized DTOs
 *
 * Scope rules:
 * - Employees: can only view their own audit logs (actor.userId = user.userId)
 * - Managers: can only view their own logs and their direct reports' logs
 * - Admins (super_admin, org_admin, hr_admin, it_admin): can view all organization logs or filter by actorId
 *
 * @param {Object} params
 * @param {Object} [params.user] Authenticated user context
 * @param {string} [params.orgId] Organization ID (fallback if user context not provided)
 * @param {string} [params.action] Optional action filter regex
 * @param {string} [params.actorId] Optional actor ID filter
 * @param {number|string} [params.page=1] Page number
 * @param {number|string} [params.limit=20] Limit per page
 * @returns {Promise<{ logs: Array, pagination: Object }>}
 */
export async function getAuditLogsService({ user, orgId: explicitOrgId, action, actorId, page = 1, limit = 20 }) {
  const callerUser = user || (explicitOrgId ? { orgId: explicitOrgId, userId: actorId || 'system', role: 'org_admin' } : null);

  if (!callerUser || !callerUser.orgId) {
    throw new AuditServiceError('Unauthorized: Valid user credentials required.', 401);
  }

  const orgId = callerUser.orgId;
  const isAdmin = AUDIT_ADMIN_ROLES.includes(callerUser.role);
  const isManager = callerUser.role === 'manager';
  const cleanActorId = typeof actorId === 'string' && actorId.trim().length > 0 ? actorId.trim() : null;

  const query = { orgId };

  if (isAdmin) {
    // Admins can view all organization logs or filter by specific actor
    if (cleanActorId) {
      query['actor.userId'] = cleanActorId;
    }
  } else if (isManager) {
    // Managers can view their own logs + their direct reports
    let reportIds = [];
    try {
      const reports = await User.find({
        orgId,
        managerId: callerUser.userId,
      }).select('userId').lean();
      reportIds = (reports || []).map((r) => r.userId);
    } catch {
      reportIds = [];
    }
    const teamActorIds = [callerUser.userId, ...reportIds];

    if (cleanActorId) {
      if (!teamActorIds.includes(cleanActorId)) {
        throw new AuditServiceError(
          'Access Denied: Managers can only view audit logs for themselves and their direct reports.',
          403
        );
      }
      query['actor.userId'] = cleanActorId;
    } else {
      query['actor.userId'] = { $in: teamActorIds };
    }
  } else {
    // Employees can ONLY view their own audit logs
    if (cleanActorId && cleanActorId !== callerUser.userId) {
      throw new AuditServiceError(
        'Access Denied: Employees can only view their own audit logs.',
        403
      );
    }
    query['actor.userId'] = callerUser.userId;
  }

  if (action && typeof action === 'string' && action.trim().length > 0) {
    query.action = new RegExp(action.trim(), 'i');
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const [logs, total] = await Promise.all([
    AuditLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    AuditLog.countDocuments(query),
  ]);

  const sanitizedLogs = (logs || []).map((log) => toAuditLogDTO(log, callerUser.role));

  return {
    logs: sanitizedLogs,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: total || 0,
      totalPages: Math.ceil(total / limitNum) || 1,
    },
  };
}

/**
 * Seed baseline audit logs if the organization's audit ledger is empty
 */
export async function seedBaselineAuditLogs(orgId = 'org_abc') {
  try {
    const existingCount = await AuditLog.countDocuments({ orgId });

    if (existingCount === 0) {
      await recordAuditLog({
        orgId,
        actor: {
          userId: 'system',
          name: 'System Initializer',
          role: 'super_admin',
        },
        action: 'SYSTEM_INITIALIZED',
        entity: {
          type: 'system',
          id: 'SYS-INIT',
        },
        changes: {
          after: { message: 'Audit log initialized.' },
        },
      });

      await recordAuditLog({
        orgId,
        actor: {
          userId: 'usr_super',
          name: 'Platform Super Admin',
          role: 'super_admin',
        },
        action: 'POLICY_INDEX_INITIALIZED',
        entity: {
          type: 'policy',
          id: 'POL-INDEX-2026',
        },
        changes: {
          after: { department: 'ALL', status: 'SYNCHRONIZED' },
        },
      });

      await recordAuditLog({
        orgId,
        actor: {
          userId: 'usr_org_admin',
          name: 'Elena Rostova',
          role: 'org_admin',
        },
        action: 'SECURITY_AUDIT_ENABLED',
        entity: {
          type: 'security',
          id: 'SEC-GOVERNANCE',
        },
        changes: {
          after: { standard: 'SOC2-Type-II', compliance: 'STRICT' },
        },
      });
    }
  } catch (err) {
    console.warn('[AuditService] seedBaselineAuditLogs notice:', err.message);
  }
}
