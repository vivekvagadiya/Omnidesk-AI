import crypto from 'node:crypto';
import { getRedisClient } from '../../config/redis.js';
import { User } from '../../models/User.model.js';
import { Ticket } from '../../models/Ticket.model.js';
import { invalidateTicketCaches, invalidateBalanceCaches } from '../cache/cache.service.js';
import { Asset } from '../../models/Asset.model.js';

export const ACTION_TOKEN_TTL_SECONDS = 900; // 15 minutes TTL
export const ACTION_PREFIX = 'action:';

export const ACTION_TYPES = {
  APPLY_LEAVE: 'APPLY_LEAVE',
  REQUEST_HARDWARE_UPGRADE: 'REQUEST_HARDWARE_UPGRADE',
};

// In-memory fallback map for offline Redis or isolated test environments
const hitlMemoryStore = new Map();

// Periodic cleanup of in-memory fallback store
const hitlCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of hitlMemoryStore.entries()) {
    if (record.expiresAtTimestamp <= now) {
      hitlMemoryStore.delete(key);
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
 * Stage a consequential action token into Redis with a 15-minute TTL
 * Does NOT execute any database mutations.
 *
 * @param {Object} params
 * @param {string} params.type Action type enum ('APPLY_LEAVE', 'REQUEST_HARDWARE_UPGRADE')
 * @param {string} params.userId Requesting user ID
 * @param {string} params.orgId Multi-tenant organization ID
 * @param {Object} params.payload Arbitrary action payload parameters
 * @param {string} [params.summary] Human-readable description
 * @param {number} [params.ttlSeconds=900] Expiration TTL (default 15 minutes)
 * @param {Object} [params.client] Redis client instance
 * @returns {Promise<Object>} Staged action details and UI card metadata
 */
export async function stageActionToken({
  type,
  userId,
  orgId,
  payload = {},
  summary = '',
  ttlSeconds = ACTION_TOKEN_TTL_SECONDS,
  client = getRedisClient(),
}) {
  if (!type || !Object.values(ACTION_TYPES).includes(type)) {
    throw new HITLError(`Invalid action type '${type}'. Allowed: ${Object.values(ACTION_TYPES).join(', ')}`);
  }

  if (!userId) {
    throw new HITLError('userId is required to stage a consequential action.');
  }

  if (!orgId) {
    throw new HITLError('orgId is required for multi-tenant isolation.');
  }

  const actionId = generateActionId();
  const redisKey = `${ACTION_PREFIX}${actionId}`;
  const now = Date.now();
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();

  const stagedAction = {
    actionId,
    type,
    userId,
    orgId,
    payload,
    summary,
    status: 'PENDING_APPROVAL',
    createdAt: new Date(now).toISOString(),
    expiresAt,
    expiresAtTimestamp: now + ttlSeconds * 1000,
    ttlSeconds,
  };

  const serialized = JSON.stringify(stagedAction);

  // 1. Write to live Redis if connected
  if (client && client.isOpen) {
    try {
      await client.set(redisKey, serialized, { EX: ttlSeconds });
    } catch (err) {
      console.warn(`⚠️ [HITL Gatekeeper] Redis set error: ${err.message}. Falling back to memory store.`);
      hitlMemoryStore.set(redisKey, stagedAction);
    }
  } else {
    // 2. Fallback to in-memory store
    hitlMemoryStore.set(redisKey, stagedAction);
  }

  const card = buildApprovalCardMetadata(stagedAction);

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
  if (client && client.isOpen) {
    try {
      const raw = await client.get(redisKey);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`⚠️ [HITL Gatekeeper] Redis get error: ${err.message}. Checking memory fallback.`);
    }
  }

  // 2. Check in-memory store
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
 * Consume a staged action token: Validates authorization, verifies TTL,
 * and atomically executes the database mutation in MongoDB upon human confirmation.
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
  if (!actionId) {
    throw new HITLError('actionId is required.');
  }

  if (!user || !user.orgId) {
    throw new UnauthorizedActionError('Authenticated user context with orgId is required.');
  }

  const normalizedDecision = decision.toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(normalizedDecision)) {
    throw new HITLError(`Invalid decision '${decision}'. Must be 'APPROVE' or 'REJECT'.`);
  }

  // 1. Fetch staged action from Redis
  const staged = await getStagedAction(actionId, client);

  if (!staged) {
    throw new ActionNotFoundError('Action token does not exist or has expired.');
  }

  // 2. Check expiration timestamp
  if (new Date(staged.expiresAt).getTime() <= Date.now()) {
    await deleteStagedAction(actionId, client);
    throw new ActionExpiredError('Action token has expired.');
  }

  // 3. Multi-Tenant Isolation Verification
  if (staged.orgId !== user.orgId) {
    throw new UnauthorizedActionError('Tenant isolation violation: Staged action belongs to a different organization.');
  }

  // 4. Handle REJECTION: Clean up token and return status
  if (normalizedDecision === 'REJECT') {
    await deleteStagedAction(actionId, client);
    return {
      success: true,
      actionId,
      status: 'REJECTED',
      type: staged.type,
      message: `Action '${staged.type}' was rejected by user. No database changes were applied.`,
    };
  }

  // 5. Handle APPROVAL: Execute database mutations atomically
  let executionResult = null;

  if (staged.type === ACTION_TYPES.APPLY_LEAVE) {
    const { leaveType, days, startDate, endDate, reason } = staged.payload;

    // A. Check user and atomically decrement leave balance in MongoDB
    const targetUserId = staged.userId;
    const leaveField = `leaveBalances.${leaveType}`;

    const updatedUser = await User.findOneAndUpdate(
      {
        userId: targetUserId,
        orgId: staged.orgId,
        [leaveField]: { $gte: days },
      },
      {
        $inc: { [leaveField]: -days },
      },
      { new: true }
    );

    if (!updatedUser) {
      // Check if user was not found or balance was insufficient
      const existingUser = await User.findOne({ userId: targetUserId, orgId: staged.orgId });
      if (!existingUser) {
        throw new HITLError(`Employee '${targetUserId}' not found in organization.`);
      }
      const available = existingUser.leaveBalances?.[leaveType] ?? 0;
      throw new HITLError(
        `Insufficient leave balance to complete approval. Requested ${days} days, but only ${available} days remain.`
      );
    }

    // B. Create a resolved Ticket record in MongoDB for auditing
    const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const ticketId = `LEAVE-${Date.now().toString(36).toUpperCase()}-${randomSuffix}`;

    const leaveTicket = await Ticket.create({
      ticketId,
      orgId: staged.orgId,
      userId: targetUserId,
      title: `Approved Leave: ${days} Day(s) (${leaveType.toUpperCase()})`,
      description: `Leave dates: ${startDate} to ${endDate || startDate}. Reason: ${reason || 'None specified'}`,
      category: 'HR_LEAVE',
      priority: 'MEDIUM',
      status: 'RESOLVED',
      stagedActionId: actionId,
      metadata: {
        leaveType,
        days,
        startDate,
        endDate: endDate || startDate,
        approvedBy: user.userId,
        approvedAt: new Date().toISOString(),
      },
    });

    executionResult = {
      type: ACTION_TYPES.APPLY_LEAVE,
      userId: targetUserId,
      leaveType,
      daysDeducted: days,
      remainingBalance: updatedUser.leaveBalances[leaveType],
      leaveBalances: updatedUser.leaveBalances,
      ticketId: leaveTicket.ticketId,
      ticketStatus: leaveTicket.status,
    };

    // Refresh the employee's balance and ticket caches (not the whole org)
    await invalidateBalanceCaches({ orgId: staged.orgId, userId: targetUserId });
    await invalidateTicketCaches({ orgId: staged.orgId, userId: targetUserId });
  } else if (staged.type === ACTION_TYPES.REQUEST_HARDWARE_UPGRADE) {
    const { assetType, preferredModel, reason, urgency } = staged.payload;

    // Create an IT support ticket in MongoDB to track hardware requisition workflow
    const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const ticketId = `HW-${Date.now().toString(36).toUpperCase()}-${randomSuffix}`;

    const hwTicket = await Ticket.create({
      ticketId,
      orgId: staged.orgId,
      userId: staged.userId,
      title: `Hardware Upgrade: ${preferredModel} (${assetType})`,
      description: `Hardware requisition confirmed by user.\nItem: ${preferredModel}\nCategory: ${assetType}\nUrgency: ${urgency || 'MEDIUM'}\nReason: ${reason}`,
      category: 'IT_HARDWARE',
      priority: urgency || 'MEDIUM',
      status: 'OPEN',
      stagedActionId: actionId,
      metadata: {
        assetType,
        preferredModel,
        reason,
        urgency,
        confirmedBy: user.userId,
        confirmedAt: new Date().toISOString(),
      },
    });

    // Refresh the requester's ticket caches
    await invalidateTicketCaches({ orgId: staged.orgId, userId: staged.userId });

    executionResult = {
      type: ACTION_TYPES.REQUEST_HARDWARE_UPGRADE,
      userId: staged.userId,
      assetType,
      preferredModel,
      ticketId: hwTicket.ticketId,
      ticketStatus: hwTicket.status,
      priority: hwTicket.priority,
    };
  } else {
    throw new HITLError(`Unhandled action type: '${staged.type}'`);
  }

  // 6. Delete action token from Redis to ensure single-use (prevent replay attacks)
  await deleteStagedAction(actionId, client);

  return {
    success: true,
    actionId,
    status: 'APPROVED',
    type: staged.type,
    result: executionResult,
    message: `Action '${staged.type}' confirmed and executed successfully.`,
  };
}
