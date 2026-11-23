import crypto from 'node:crypto';
import { getRedisClient } from '../../config/redis.js';
import { config } from '../../config/environment.js';
import { User } from '../../models/User.model.js';
import { Ticket } from '../../models/Ticket.model.js';
import { invalidateTicketCaches, invalidateBalanceCaches } from '../cache/cache.service.js';
import { notify } from '../notifications/notification.service.js';
import { recordAuditLog } from '../audit/audit.service.js';

export const ACTION_TOKEN_TTL_SECONDS = 900; // 15 minutes TTL
export const ACTION_PREFIX = 'action:';
export const ACTION_LOCK_PREFIX = 'action:lock:';

/**
 * Atomic Redis Lua script to release an acquired lock only if the token matches.
 * Prevents race conditions where an expired lock could delete a newer lock.
 */
const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Atomic Redis Lua script to extend / renew lock TTL only if the token matches.
 * Returns 1 if extended, 0 if lock expired or token mismatch.
 */
const EXTEND_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], tonumber(ARGV[2]))
else
  return 0
end
`;

export const ACTION_TYPES = {
  APPLY_LEAVE: 'APPLY_LEAVE',
  REQUEST_HARDWARE_UPGRADE: 'REQUEST_HARDWARE_UPGRADE',
};

// In-memory fallback stores strictly for offline/test environments
const hitlMemoryStore = new Map();
const hitlLockStore = new Map();

// Periodic cleanup of in-memory fallback store in test/dev
const hitlCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of hitlMemoryStore.entries()) {
    if (record.expiresAtTimestamp <= now) {
      hitlMemoryStore.delete(key);
    }
  }
  for (const [key, record] of hitlLockStore.entries()) {
    const expiresAt = typeof record === 'object' && record !== null ? record?.expiresAt : record;
    if (expiresAt <= now) {
      hitlLockStore.delete(key);
    }
  }
}, 60 * 1000);

if (hitlCleanupTimer.unref) {
  hitlCleanupTimer.unref();
}

/**
 * Custom Error Classes for HITL Action Gatekeeper
 */
export class HITLError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'HITLError';
    this.statusCode = statusCode;
  }
}

export class ActionNotFoundError extends HITLError {
  constructor(message = 'Action token does not exist or has expired.') {
    super(message, 404);
    this.name = 'ActionNotFoundError';
  }
}

export class ActionExpiredError extends HITLError {
  constructor(message = 'Action token has expired. Please initiate the request again.') {
    super(message, 410);
    this.name = 'ActionExpiredError';
  }
}

export class UnauthorizedActionError extends HITLError {
  constructor(message = 'Unauthorized action: Access denied for current tenant or user.') {
    super(message, 403);
    this.name = 'UnauthorizedActionError';
  }
}

/**
 * Generate a cryptographically secure action ID
 * Format: act_<32 hex chars>
 *
 * @returns {string} Unique action token ID
 */
export function generateActionId() {
  const hex = crypto.randomBytes(16).toString('hex');
  return `act_${hex}`;
}

/**
 * Build rich UI card metadata for frontend Human-in-the-Loop rendering
 *
 * @param {Object} stagedAction
 * @returns {Object} Structured UI card representation
 */
export function buildApprovalCardMetadata(stagedAction) {
  const { actionId, type, payload, expiresAt, summary } = stagedAction;

  if (type === ACTION_TYPES.APPLY_LEAVE) {
    return {
      cardType: 'HITL_APPROVAL_CARD',
      actionId,
      type,
      title: `Confirm Leave Application: ${payload.days} Day(s)`,
      summary:
        summary ||
        `Request to take ${payload.days} day(s) of ${payload.leaveType} leave starting ${payload.startDate}.`,
      details: {
        'Leave Type': payload.leaveType?.toUpperCase(),
        'Duration': `${payload.days} day(s)`,
        'Start Date': payload.startDate,
        'End Date': payload.endDate || payload.startDate,
        'Remaining After Approval': `${payload.newBalanceAfterApproval} day(s)`,
        'Reason': payload.reason || 'None specified',
      },
      status: 'PENDING_APPROVAL',
      expiresAt,
      actions: [
        {
          action: 'APPROVE',
          label: 'Approve & Deduct Leave',
          variant: 'success',
          actionId,
        },
        {
          action: 'REJECT',
          label: 'Cancel Request',
          variant: 'danger',
          actionId,
        },
      ],
    };
  }

  if (type === ACTION_TYPES.REQUEST_HARDWARE_UPGRADE) {
    return {
      cardType: 'HITL_APPROVAL_CARD',
      actionId,
      type,
      title: `Confirm Hardware Requisition: ${payload.preferredModel}`,
      summary:
        summary ||
        `Hardware requisition for ${payload.preferredModel} (${payload.assetType}). Requires manager/IT authorization.`,
      details: {
        'Asset Category': payload.assetType,
        'Preferred Model': payload.preferredModel,
        'Urgency Level': payload.urgency || 'MEDIUM',
        'Business Justification': payload.reason,
      },
      status: 'PENDING_APPROVAL',
      expiresAt,
      actions: [
        {
          action: 'APPROVE',
          label: 'Authorize Requisition',
          variant: 'success',
          actionId,
        },
        {
          action: 'REJECT',
          label: 'Decline Requisition',
          variant: 'danger',
          actionId,
        },
      ],
    };
  }

  return {
    cardType: 'HITL_APPROVAL_CARD',
    actionId,
    type,
    title: `Pending Authorization: ${type}`,
    summary: summary || 'Action requires explicit user confirmation.',
    details: payload,
    status: 'PENDING_APPROVAL',
    expiresAt,
    actions: [
      { action: 'APPROVE', label: 'Approve', variant: 'success', actionId },
      { action: 'REJECT', label: 'Reject', variant: 'danger', actionId },
    ],
  };
}

/**
 * Acquire a single-use execution lock for an action token to prevent concurrent double-approvals.
 * Generates a unique lock token stored alongside the lock key with TTL.
 *
 * @param {string} actionId Staged action ID
 * @param {string} [userId] Requesting or approving user ID
 * @param {Object} [client] Redis client instance
 * @param {number} [lockTtlSeconds=30] Lock TTL in seconds
 * @returns {Promise<string|null>} Unique lock token if acquired, null if already locked
 */
export async function acquireActionLock(actionId, userId, client = getRedisClient(), lockTtlSeconds = 30) {
  const lockKey = `${ACTION_LOCK_PREFIX}${actionId}`;
  const lockToken = `lck_${crypto.randomUUID()}`;

  if (client && (client.isReady || client.isOpen)) {
    try {
      const res = await client.set(lockKey, lockToken, { NX: true, EX: lockTtlSeconds });
      return res === 'OK' ? lockToken : null;
    } catch (err) {
      if (config.nodeEnv === 'production') {
        throw new HITLError(`Unable to acquire action lock: State Redis error - ${err.message}`, 503);
      }
    }
  } else if (config.nodeEnv === 'production') {
    throw new HITLError('Unable to acquire action lock: State Redis is unavailable.', 503);
  }

  // Non-production in-memory lock
  const now = Date.now();
  const existingLock = hitlLockStore.get(lockKey);
  const existingExpiresAt = typeof existingLock === 'object' && existingLock !== null ? existingLock?.expiresAt : existingLock;
  if (existingExpiresAt && existingExpiresAt > now) {
    return null;
  }
  hitlLockStore.set(lockKey, { lockToken, expiresAt: now + lockTtlSeconds * 1000 });
  return lockToken;
}

/**
 * Release an execution lock using an atomic compare-and-delete Lua script to ensure
 * an expired lock does not accidentally delete a newer lock acquired by another request.
 *
 * @param {string} actionId Staged action ID
 * @param {string} lockToken Unique lock token generated at acquisition (mandatory)
 * @param {Object} [client] Redis client instance
 */
export async function releaseActionLock(actionId, lockToken, client = getRedisClient()) {
  if (!actionId || !lockToken) {
    throw new HITLError('actionId and lockToken are strictly required to release action lock.', 400);
  }
  const lockKey = `${ACTION_LOCK_PREFIX}${actionId}`;

  if (client && (client.isReady || client.isOpen)) {
    try {
      await client.eval(RELEASE_LOCK_LUA, {
        keys: [lockKey],
        arguments: [String(lockToken)],
      });
    } catch (err) {
      if (config.nodeEnv === 'production') {
        console.error(`🚨 [HITL Gatekeeper] Redis lock release failed in production (${lockKey}): ${err.message}`);
      }
    }
  }

  const inMem = hitlLockStore.get(lockKey);
  if (inMem) {
    const memToken = typeof inMem === 'object' && inMem !== null ? inMem.lockToken : null;
    const memExpiresAt = typeof inMem === 'object' && inMem !== null ? inMem.expiresAt : inMem;
    if (memToken === lockToken || memExpiresAt <= Date.now()) {
      hitlLockStore.delete(lockKey);
    }
  }
}

/**
 * Extend / renew an active execution lock atomically using Redis Lua script.
 * Verifies that the current lock value matches the unique lockToken before extending TTL.
 *
 * @param {string} actionId Staged action ID
 * @param {string} lockToken Unique lock token generated at acquisition
 * @param {Object} [client] Redis client instance
 * @param {number} [lockTtlSeconds=30] Lock TTL in seconds
 * @returns {Promise<boolean>} True if renewed, false if lock was lost / mismatch
 */
export async function extendActionLock(actionId, lockToken, client = getRedisClient(), lockTtlSeconds = 30) {
  if (!actionId || !lockToken) return false;
  const lockKey = `${ACTION_LOCK_PREFIX}${actionId}`;

  if (client && (client.isReady || client.isOpen)) {
    try {
      const res = await client.eval(EXTEND_LOCK_LUA, {
        keys: [lockKey],
        arguments: [String(lockToken), String(lockTtlSeconds)],
      });
      return res === 1;
    } catch (err) {
      if (config.nodeEnv === 'production') {
        console.error(`🚨 [HITL Gatekeeper] Lock renewal failed in production (${lockKey}): ${err.message}`);
      }
      return false;
    }
  }

  // Non-production in-memory lock store renewal
  const inMem = hitlLockStore.get(lockKey);
  if (inMem && typeof inMem === 'object' && inMem.lockToken === lockToken && inMem.expiresAt > Date.now()) {
    inMem.expiresAt = Date.now() + lockTtlSeconds * 1000;
    return true;
  }
  return false;
}

/**
 * Stage a consequential action token into Redis with a 15-minute TTL.
 * Binds token to organization, requesting user, intended action, target entity, and expiration.
 * Does NOT execute any database mutations.
 *
 * @param {Object} params
 * @param {string} params.type Action type enum ('APPLY_LEAVE', 'REQUEST_HARDWARE_UPGRADE')
 * @param {string} params.userId Requesting user ID
 * @param {string} params.orgId Multi-tenant organization ID
 * @param {Object} [params.targetEntity] Target entity reference ({ type, id })
 * @param {Object} [params.payload] Action payload parameters
 * @param {string} [params.summary] Human-readable description
 * @param {number} [params.ttlSeconds=900] Expiration TTL (default 15 minutes)
 * @param {Object} [params.client] Redis client instance
 * @returns {Promise<Object>} Staged action details and UI card metadata
 */
export async function stageActionToken({
  type,
  userId,
  orgId,
  targetEntity = null,
  payload = {},
  summary = '',
  ttlSeconds = ACTION_TOKEN_TTL_SECONDS,
  client = getRedisClient(),
}) {
  if (!type || !Object.values(ACTION_TYPES).includes(type)) {
    throw new HITLError(`Invalid action type '${type}'. Allowed: ${Object.values(ACTION_TYPES).join(', ')}`);
  }

  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    throw new HITLError('userId is required to stage a consequential action.');
  }

  if (!orgId || typeof orgId !== 'string' || !orgId.trim()) {
    throw new HITLError('orgId is required for multi-tenant isolation.');
  }

  const actionId = generateActionId();
  const redisKey = `${ACTION_PREFIX}${actionId}`;
  const now = Date.now();
  const expiresAtTimestamp = now + ttlSeconds * 1000;
  const expiresAt = new Date(expiresAtTimestamp).toISOString();

  // Resolve target entity binding
  const boundTargetEntity = targetEntity || (
    type === ACTION_TYPES.APPLY_LEAVE
      ? { type: 'user', id: userId.trim() }
      : { type: 'hardware_requisition', id: payload?.preferredModel || payload?.assetType || userId.trim() }
  );

  const stagedAction = {
    actionId,
    type,
    userId: userId.trim(),
    orgId: orgId.trim(),
    targetEntity: boundTargetEntity,
    payload,
    summary,
    status: 'PENDING_APPROVAL',
    createdAt: new Date(now).toISOString(),
    expiresAt,
    expiresAtTimestamp,
    ttlSeconds,
  };

  const serialized = JSON.stringify(stagedAction);

  // 1. Write to live Redis if connected
  if (client && (client.isReady || client.isOpen)) {
    try {
      await client.set(redisKey, serialized, { EX: ttlSeconds });
    } catch (err) {
      if (config.nodeEnv === 'production') {
        throw new HITLError(`Failed to stage action: State Redis error - ${err.message}`, 503);
      }
      console.warn(`⚠️ [HITL Gatekeeper] Redis set error: ${err.message}. Using test memory store.`);
      hitlMemoryStore.set(redisKey, stagedAction);
    }
  } else if (config.nodeEnv === 'production') {
    throw new HITLError('Unable to stage action: State Redis is unavailable.', 503);
  } else {
    // 2. In-memory store fallback strictly in non-production environments
    hitlMemoryStore.set(redisKey, stagedAction);
  }

  const card = buildApprovalCardMetadata(stagedAction);

  recordAuditLog({
    orgId: orgId.trim(),
    actor: {
      userId: userId.trim(),
      role: 'employee',
    },
    action: `HITL_ACTION_STAGED:${type}`,
    entity: {
      type: 'staged_action',
      id: actionId,
    },
    changes: {
      after: payload,
    },
  }).catch((err) => {
    console.error(`🚨 [AuditLog] Failed to record audit log for staged action (${actionId}): ${err.message}`);
  });

  return {
    actionId,
    stagedAction,
    card,
  };
}

/**
 * Retrieve a staged action from Redis or in-memory fallback
 *
 * @param {string} actionId Staged action ID (act_...)
 * @param {Object} [client] Redis client instance
 * @returns {Promise<Object|null>} Staged action object or null
 */
export async function getStagedAction(actionId, client = getRedisClient()) {
  if (!actionId) return null;

  const redisKey = `${ACTION_PREFIX}${actionId}`;

  // 1. Check Redis if connected
  if (client && (client.isReady || client.isOpen)) {
    try {
      const raw = await client.get(redisKey);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (err) {
      if (config.nodeEnv === 'production') {
        throw new HITLError(`Failed to retrieve staged action: State Redis error - ${err.message}`, 503);
      }
      console.warn(`⚠️ [HITL Gatekeeper] Redis get error: ${err.message}. Checking test memory store.`);
    }
  } else if (config.nodeEnv === 'production') {
    throw new HITLError('Unable to retrieve staged action: State Redis is unavailable.', 503);
  }

  // 2. Check in-memory store in non-production
  const memRecord = hitlMemoryStore.get(redisKey);
  if (memRecord) {
    if (memRecord.expiresAtTimestamp <= Date.now()) {
      hitlMemoryStore.delete(redisKey);
      return null;
    }
    return memRecord;
  }

  return null;
}

/**
 * Delete / invalidate a staged action token from Redis
 *
 * @param {string} actionId
 * @param {Object} [client]
 */
export async function deleteStagedAction(actionId, client = getRedisClient()) {
  if (!actionId) return;

  const redisKey = `${ACTION_PREFIX}${actionId}`;

  if (client && client.isOpen) {
    try {
      await client.del(redisKey);
    } catch (err) {
      console.warn(`⚠️ [HITL Gatekeeper] Redis del error: ${err.message}`);
    }
  }

  hitlMemoryStore.delete(redisKey);
}

/**
 * Approval Business Rules: Check if the user is authorized to approve or reject the staged action.
 *
 * Rules:
 * 1. Must belong to the exact same organization (orgId).
 * 2. Self-approval: Requester can confirm their own request (e.g. employee requesting leave/hardware).
 * 3. Super admin and Org admin can approve/reject all organizational actions.
 * 4. Action-specific RBAC:
 *    - APPLY_LEAVE: hr_admin OR manager of the employee (direct report).
 *    - REQUEST_HARDWARE_UPGRADE: it_admin OR manager of the employee (direct report).
 *
 * @param {Object} params
 * @param {Object} params.stagedAction Staged action object
 * @param {Object} params.user Authenticated decision maker
 * @returns {Promise<boolean>}
 */
export async function isUserAuthorizedToDecide({ stagedAction, user }) {
  if (!stagedAction || !user) return false;

  // Strict tenant boundary
  if (stagedAction.orgId !== user.orgId) {
    return false;
  }

  // Self-approval: Requester confirming their own staged action
  if (stagedAction.userId === user.userId) {
    return true;
  }

  // Administrative super-roles
  if (['super_admin', 'org_admin'].includes(user.role)) {
    return true;
  }

  // Departmental and managerial roles
  if (stagedAction.type === ACTION_TYPES.APPLY_LEAVE) {
    if (user.role === 'hr_admin') {
      return true;
    }
    if (user.role === 'manager') {
      return isDirectReport({ orgId: user.orgId, managerId: user.userId, employeeId: stagedAction.userId });
    }
  }

  if (stagedAction.type === ACTION_TYPES.REQUEST_HARDWARE_UPGRADE) {
    if (user.role === 'it_admin') {
      return true;
    }
    if (user.role === 'manager') {
      return isDirectReport({ orgId: user.orgId, managerId: user.userId, employeeId: stagedAction.userId });
    }
  }

  return false;
}

/**
 * Check if an employee reports directly to a manager
 */
async function isDirectReport({ orgId, managerId, employeeId }) {
  if (User.db?.readyState === 1 || typeof User.findOne === 'function') {
    const report = await User.findOne({
      orgId,
      userId: employeeId,
      managerId,
    }).select('userId').lean();
    return Boolean(report);
  }
  return false;
}

/**
 * Action Execution Logic: Executes database mutations upon approval.
 *
 * @param {Object} params
 * @param {Object} params.stagedAction Staged action record
 * @param {Object} params.user Authenticated user who approved
 * @returns {Promise<Object>} Execution result payload
 */
export async function executeApprovedAction({ stagedAction, user }) {
  if (stagedAction.type === ACTION_TYPES.APPLY_LEAVE) {
    return executeApplyLeave({ stagedAction, user });
  }

  if (stagedAction.type === ACTION_TYPES.REQUEST_HARDWARE_UPGRADE) {
    return executeRequestHardwareUpgrade({ stagedAction, user });
  }

  throw new HITLError(`Unhandled action type: '${stagedAction.type}'`);
}

/**
 * Execute leave application mutations:
 * 1. Atomically decrements leave balance in MongoDB using conditional update.
 * 2. Creates a resolved Ticket audit record.
 * 3. Applies compensating rollback if ticket creation fails.
 * 4. Invalidates caches and notifies stakeholders.
 */
async function executeApplyLeave({ stagedAction, user }) {
  const { leaveType, days, startDate, endDate, reason } = stagedAction.payload;
  const targetUserId = stagedAction.userId;
  const leaveField = `leaveBalances.${leaveType}`;

  // 1. Create resolved Ticket audit record FIRST with unique stagedActionId constraint.
  // Acts as the durable atomic database-level idempotency anchor:
  // If another concurrent request or retry executes this action, MongoDB rejects it with E11000.
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ticketId = `LEAVE-${Date.now().toString(36).toUpperCase()}-${randomSuffix}`;

  let leaveTicket;
  try {
    leaveTicket = await Ticket.create({
      ticketId,
      orgId: stagedAction.orgId,
      userId: targetUserId,
      title: `Approved Leave: ${days} Day(s) (${leaveType.toUpperCase()})`,
      description: `Leave dates: ${startDate} to ${endDate || startDate}. Reason: ${reason || 'None specified'}`,
      category: 'HR_LEAVE',
      priority: 'MEDIUM',
      status: 'RESOLVED',
      stagedActionId: stagedAction.actionId,
      metadata: {
        leaveType,
        days,
        startDate,
        endDate: endDate || startDate,
        approvedBy: user.userId,
        approvedAt: new Date().toISOString(),
      },
    });
  } catch (ticketErr) {
    if (ticketErr.code === 11000 || (ticketErr.name === 'MongoServerError' && ticketErr.code === 11000)) {
      throw new ActionNotFoundError('Action token has already been executed.');
    }
    throw ticketErr;
  }

  // 2. Atomically decrement leave balance in MongoDB using conditional update
  let updatedUser;
  try {
    updatedUser = await User.findOneAndUpdate(
      {
        userId: targetUserId,
        orgId: stagedAction.orgId,
        [leaveField]: { $gte: days },
      },
      {
        $inc: { [leaveField]: -days },
      },
      { new: true }
    );

    if (!updatedUser) {
      const existingUser = await User.findOne({ userId: targetUserId, orgId: stagedAction.orgId });
      if (!existingUser) {
        throw new HITLError(`Employee '${targetUserId}' not found in organization.`);
      }
      const available = existingUser.leaveBalances?.[leaveType] ?? 0;
      throw new HITLError(
        `Insufficient leave balance to complete approval. Requested ${days} days, but only ${available} days remain.`
      );
    }
  } catch (userErr) {
    // If leave balance deduction fails, roll back ticket creation
    await Ticket.deleteOne({ ticketId: leaveTicket.ticketId, orgId: stagedAction.orgId }).catch(() => {});
    throw userErr;
  }

  const executionResult = {
    type: ACTION_TYPES.APPLY_LEAVE,
    userId: targetUserId,
    leaveType,
    daysDeducted: days,
    remainingBalance: updatedUser.leaveBalances[leaveType],
    leaveBalances: updatedUser.leaveBalances,
    ticketId: leaveTicket.ticketId,
    ticketStatus: leaveTicket.status,
  };

  // Cache invalidation (non-fatal)
  try {
    await invalidateBalanceCaches({ orgId: stagedAction.orgId, userId: targetUserId });
    await invalidateTicketCaches({ orgId: stagedAction.orgId, userId: targetUserId });
  } catch (cacheErr) {
    console.warn(`⚠️ [HITL Gatekeeper] Cache invalidation notice: ${cacheErr.message}`);
  }

  // Notifications
  try {
    await notify('LEAVE_APPROVED', {
      orgId: stagedAction.orgId,
      actor: { userId: user.userId, name: user.name },
      employeeId: targetUserId,
      employeeName: updatedUser.name,
      leaveType,
      days,
      startDate,
      endDate: endDate || startDate,
      ticketId: leaveTicket.ticketId,
      remaining: updatedUser.leaveBalances[leaveType],
    });
  } catch (notifyErr) {
    console.warn(`⚠️ [HITL Gatekeeper] Notification notice: ${notifyErr.message}`);
  }

  return executionResult;
}

/**
 * Execute hardware upgrade request mutation:
 * 1. Creates an IT support ticket in MongoDB with unique stagedActionId constraint.
 * 2. Invalidates ticket caches and notifies IT administrators.
 */
async function executeRequestHardwareUpgrade({ stagedAction, user }) {
  const { assetType, preferredModel, reason, urgency } = stagedAction.payload;

  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ticketId = `HW-${Date.now().toString(36).toUpperCase()}-${randomSuffix}`;

  let hwTicket;
  try {
    hwTicket = await Ticket.create({
      ticketId,
      orgId: stagedAction.orgId,
      userId: stagedAction.userId,
      title: `Hardware Upgrade: ${preferredModel} (${assetType})`,
      description: `Hardware requisition confirmed by user.\nItem: ${preferredModel}\nCategory: ${assetType}\nUrgency: ${urgency || 'MEDIUM'}\nReason: ${reason}`,
      category: 'IT_HARDWARE',
      priority: urgency || 'MEDIUM',
      status: 'OPEN',
      stagedActionId: stagedAction.actionId,
      metadata: {
        assetType,
        preferredModel,
        reason,
        urgency,
        confirmedBy: user.userId,
        confirmedAt: new Date().toISOString(),
      },
    });
  } catch (ticketErr) {
    if (ticketErr.code === 11000 || (ticketErr.name === 'MongoServerError' && ticketErr.code === 11000)) {
      throw new ActionNotFoundError('Action token has already been executed.');
    }
    throw ticketErr;
  }

  // Invalidate ticket cache (non-fatal)
  try {
    await invalidateTicketCaches({ orgId: stagedAction.orgId, userId: stagedAction.userId });
  } catch (cacheErr) {
    console.warn(`⚠️ [HITL Gatekeeper] Cache invalidation notice: ${cacheErr.message}`);
  }

  // Notifications
  try {
    await notify('HARDWARE_REQUESTED', {
      orgId: stagedAction.orgId,
      actor: { userId: stagedAction.userId, name: user.name },
      ticket: { ticketId: hwTicket.ticketId, title: hwTicket.title, priority: hwTicket.priority },
      preferredModel,
    });
  } catch (notifyErr) {
    console.warn(`⚠️ [HITL Gatekeeper] Notification notice: ${notifyErr.message}`);
  }

  return {
    type: ACTION_TYPES.REQUEST_HARDWARE_UPGRADE,
    userId: stagedAction.userId,
    assetType,
    preferredModel,
    ticketId: hwTicket.ticketId,
    ticketStatus: hwTicket.status,
    priority: hwTicket.priority,
  };
}

/**
 * Consume a staged action token: Validates authorization, verifies TTL,
 * ensures single-use execution with anti-concurrency locking, and executes
 * the database mutation in MongoDB upon human confirmation.
 *
 * @param {Object} params
 * @param {string} params.actionId Staged action ID (act_...)
 * @param {Object} params.user Authenticated user executing the decision
 * @param {string} [params.decision='APPROVE'] Decision: 'APPROVE' | 'REJECT'
 * @param {Object} [params.client] Redis client instance
 * @returns {Promise<Object>} Execution result payload
 */
export async function consumeActionToken({
  actionId,
  user,
  decision = 'APPROVE',
  client = getRedisClient(),
}) {
  if (!actionId || typeof actionId !== 'string' || !actionId.trim()) {
    throw new HITLError('actionId is required.');
  }

  if (!user || !user.orgId) {
    throw new UnauthorizedActionError('Authenticated user context with orgId is required.');
  }

  const cleanActionId = actionId.trim();
  const normalizedDecision = decision.toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(normalizedDecision)) {
    throw new HITLError(`Invalid decision '${decision}'. Must be 'APPROVE' or 'REJECT'.`);
  }

  // 1. Acquire single-use execution lock to prevent concurrent double-approvals
  const lockToken = await acquireActionLock(cleanActionId, user.userId, client);
  if (!lockToken) {
    throw new HITLError('Action approval is currently being processed concurrently.', 409);
  }

  // Active lock renewal heartbeat to prevent expiration during long executions
  let renewalTimer = null;
  let lockLost = false;

  const startHeartbeat = () => {
    renewalTimer = setInterval(async () => {
      try {
        const renewed = await extendActionLock(cleanActionId, lockToken, client, 30);
        if (!renewed) {
          lockLost = true;
          clearInterval(renewalTimer);
          renewalTimer = null;
          console.warn(`⚠️ [HITL Gatekeeper] Lock renewal failed for '${cleanActionId}'. Lock ownership lost.`);
        }
      } catch (err) {
        lockLost = true;
        clearInterval(renewalTimer);
        renewalTimer = null;
        console.error(`🚨 [HITL Gatekeeper] Error in lock renewal heartbeat (${cleanActionId}): ${err.message}`);
      }
    }, 10000); // Heartbeat runs every 10 seconds for 30s TTL
    if (renewalTimer.unref) renewalTimer.unref();
  };

  const stopHeartbeat = () => {
    if (renewalTimer) {
      clearInterval(renewalTimer);
      renewalTimer = null;
    }
  };

  startHeartbeat();

  try {
    // 2. Fetch staged action from Redis (or memory fallback in non-production)
    const staged = await getStagedAction(cleanActionId, client);

    if (!staged) {
      throw new ActionNotFoundError('Action token does not exist or has expired.');
    }

    // 3. Expiration Verification
    if (new Date(staged.expiresAt).getTime() <= Date.now()) {
      await deleteStagedAction(cleanActionId, client);
      throw new ActionExpiredError('Action token has expired.');
    }

    // 4. Multi-Tenant Isolation Verification
    if (staged.orgId !== user.orgId) {
      throw new UnauthorizedActionError('Tenant isolation violation: Staged action belongs to a different organization.');
    }

    // 5. Authorization Verification (Approval Business Rules)
    const isAuthorized = await isUserAuthorizedToDecide({ stagedAction: staged, user });
    if (!isAuthorized) {
      throw new UnauthorizedActionError(
        `Access denied: Role '${user.role}' lacks permission to authorize or reject this ${staged.type} action.`
      );
    }

    // Verify lock integrity before proceeding with state-dependent operations
    if (lockLost) {
      throw new HITLError('Action lock renewal failed: Lock ownership lost during execution.', 409);
    }

    // 6. Idempotency Check: Verify database has not already processed this token
    if (Ticket.db?.readyState === 1 || typeof Ticket.findOne === 'function') {
      const existingTicket = await Ticket.findOne({
        orgId: staged.orgId,
        stagedActionId: cleanActionId,
      }).select('ticketId status').lean();

      if (existingTicket) {
        await deleteStagedAction(cleanActionId, client);
        throw new ActionNotFoundError('Action token has already been executed.');
      }
    }

    // 7. Handle REJECTION: Clean up token and return status
    if (normalizedDecision === 'REJECT') {
      if (lockLost) {
        throw new HITLError('Action lock lost during execution: Rejection aborted.', 409);
      }

      await deleteStagedAction(cleanActionId, client);

      recordAuditLog({
        orgId: staged.orgId,
        actor: {
          userId: user.userId,
          name: user.name || user.userId,
          role: user.role,
        },
        action: `HITL_ACTION_REJECTED:${staged.type}`,
        entity: {
          type: 'staged_action',
          id: cleanActionId,
        },
        changes: {
          before: staged.payload,
        },
      }).catch((err) => {
        console.error(`🚨 [AuditLog] Failed to record audit log for action rejection (${cleanActionId}): ${err.message}`);
      });

      return {
        success: true,
        actionId: cleanActionId,
        status: 'REJECTED',
        type: staged.type,
        message: `Action '${staged.type}' was rejected by user. No database changes were applied.`,
      };
    }

    // Check lock ownership immediately prior to executing database mutations
    if (lockLost) {
      throw new HITLError('Action lock renewal failed: Lock ownership lost prior to mutation execution.', 409);
    }

    // 8. Handle APPROVAL: Execute database mutations
    let executionResult;
    try {
      executionResult = await executeApprovedAction({ stagedAction: staged, user });
    } catch (execErr) {
      if (execErr.code === 11000 || (execErr.name === 'MongoServerError' && execErr.code === 11000)) {
        await deleteStagedAction(cleanActionId, client);
        throw new ActionNotFoundError('Action token has already been executed.');
      }
      throw execErr;
    }

    // 9. Single-Use Consumption: Expunge action token immediately to prevent replay attacks
    await deleteStagedAction(cleanActionId, client);

    recordAuditLog({
      orgId: staged.orgId,
      actor: {
        userId: user.userId,
        name: user.name || user.userId,
        role: user.role,
      },
      action: `HITL_ACTION_APPROVED:${staged.type}`,
      entity: {
        type: 'staged_action',
        id: cleanActionId,
      },
      changes: {
        before: staged.payload,
        after: { ...staged.payload, result: executionResult },
      },
    }).catch((err) => {
      console.error(`🚨 [AuditLog] Failed to record audit log for action approval (${cleanActionId}): ${err.message}`);
    });

    return {
      success: true,
      actionId: cleanActionId,
      status: 'APPROVED',
      type: staged.type,
      result: executionResult,
      message: `Action '${staged.type}' confirmed and executed successfully.`,
    };
  } finally {
    stopHeartbeat();
    // Release execution lock safely using atomic compare-and-delete
    await releaseActionLock(cleanActionId, lockToken, client);
  }
}
