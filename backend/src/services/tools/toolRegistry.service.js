import crypto from 'node:crypto';
import { User } from '../../models/User.model.js';
import { Ticket, TICKET_CATEGORIES, TICKET_PRIORITIES } from '../../models/Ticket.model.js';
import { Asset, ASSET_TYPES } from '../../models/Asset.model.js';
import { retrievePolicyContext } from '../rag/retrieval.service.js';
import {
  stageActionToken,
  ACTION_TYPES,
} from './hitlGatekeeper.service.js';

export const SAFE_TOOLS = ['searchPolicies', 'getLeaveBalance', 'getMyTickets'];
export const MUTATION_TOOLS = ['createTicket'];
export const CONSEQUENTIAL_TOOLS = ['applyLeave', 'requestHardwareUpgrade'];

export class ToolExecutionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ToolExecutionError';
    this.statusCode = statusCode;
  }
}

export class InvalidToolError extends ToolExecutionError {
  constructor(toolName) {
    super(`Tool '${toolName}' is not registered or supported.`, 404);
    this.name = 'InvalidToolError';
  }
}

/**
 * 1. searchPolicies (Safe Tool)
 * Queries Qdrant vector store with tenant and role isolation for policy answers.
 *
 * @param {Object} args
 * @param {string} args.query Search query or question
 * @param {string} [args.department] Optional department filter (e.g. 'HR', 'IT')
 * @param {Object} context Execution context with authenticated user
 * @returns {Promise<Object>} Formatted policy retrieval results
 */
export async function searchPolicies(args = {}, context = {}) {
  const { query, department } = args;
  const { user, embeddingProvider, qdrantClient } = context;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    throw new ToolExecutionError("Argument 'query' is required for searchPolicies.");
  }

  if (!user || !user.orgId) {
    throw new ToolExecutionError('Authenticated user context with orgId is required.');
  }

  const retrieval = await retrievePolicyContext({
    query: query.trim(),
    user,
    department: department || null,
    embeddingProvider: embeddingProvider || null,
    qdrantClient: qdrantClient || null,
  });

  return {
    tool: 'searchPolicies',
    isGrounded: Boolean(retrieval?.isGrounded),
    query: retrieval?.query || query,
    contextBlock: retrieval?.contextBlock || '',
    chunks: retrieval?.chunks || [],
    totalResults: retrieval?.chunks ? retrieval.chunks.length : 0,
    fallbackMessage: retrieval?.fallbackMessage || null,
    suggestedAction: retrieval?.suggestedAction || null,
  };
}

/**
 * 2. getLeaveBalance (Safe Tool)
 * Queries MongoDB for the user's available leave days (casual, sick, maternity).
 * Enforces RBAC: Employees can only view their own balance; managers/admins can view subordinates.
 *
 * @param {Object} args
 * @param {string} [args.userId] Target employee ID (defaults to authenticated user)
 * @param {Object} context Execution context with authenticated user
 * @returns {Promise<Object>} Employee leave balances
 */
export async function getLeaveBalance(args = {}, context = {}) {
  const { user } = context;

  if (!user || !user.orgId || !user.userId) {
    throw new ToolExecutionError('Authenticated user context is required.');
  }

  const targetUserId = args.userId && typeof args.userId === 'string' ? args.userId.trim() : user.userId;

  // RBAC Check: Non-admins cannot inspect other users' balances
  if (targetUserId !== user.userId) {
    const privilegedRoles = ['super_admin', 'org_admin', 'hr_admin', 'manager'];
    if (!privilegedRoles.includes(user.role)) {
      throw new ToolExecutionError(
        `Access denied: Employee '${user.userId}' does not have permission to view other users' leave balances.`,
        403
      );
    }
  }

  const employeeDoc = await User.findOne({
    userId: targetUserId,
    orgId: user.orgId,
  }).select('userId name email department role leaveBalances');

  if (!employeeDoc) {
    throw new ToolExecutionError(`User '${targetUserId}' was not found in this organization.`, 404);
  }

  return {
    tool: 'getLeaveBalance',
    userId: employeeDoc.userId,
    name: employeeDoc.name,
    department: employeeDoc.department,
    role: employeeDoc.role,
    leaveBalances: employeeDoc.leaveBalances || { casual: 0, sick: 0, maternity: 0 },
  };
}

/**
 * 3. getMyTickets (Safe Tool)
 * Queries MongoDB for the employee's active or past support tickets.
 *
 * @param {Object} args
 * @param {string} [args.status] Optional filter: 'OPEN', 'IN_PROGRESS', 'RESOLVED', 'ALL'
 * @param {number} [args.limit=10] Max records to return
 * @param {Object} context Execution context with authenticated user
 * @returns {Promise<Object>} List of support tickets
 */
export async function getMyTickets(args = {}, context = {}) {
  const { user } = context;

  if (!user || !user.orgId || !user.userId) {
    throw new ToolExecutionError('Authenticated user context is required.');
  }

  const query = {
    orgId: user.orgId,
    userId: user.userId,
  };

  if (args.status && typeof args.status === 'string' && args.status.toUpperCase() !== 'ALL') {
    query.status = args.status.toUpperCase();
  }

  const maxLimit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);

  const tickets = await Ticket.find(query)
    .sort({ createdAt: -1 })
    .limit(maxLimit)
    .lean();

  return {
    tool: 'getMyTickets',
    userId: user.userId,
    count: tickets.length,
    tickets: tickets.map((t) => ({
      ticketId: t.ticketId,
      title: t.title,
      description: t.description,
      category: t.category,
      priority: t.priority,
      status: t.status,
      assignedTo: t.assignedTo || null,
      createdAt: t.createdAt,
    })),
  };
}

/**
 * 4. createTicket (Write Tool)
 * Directly creates and inserts a new support ticket into MongoDB.
 *
 * @param {Object} args
 * @param {string} args.title Summary of the issue
 * @param {string} [args.description] Full issue description
 * @param {string} [args.category='GENERAL'] Ticket category
 * @param {string} [args.priority='MEDIUM'] Ticket priority
 * @param {Object} context Execution context with authenticated user
 * @returns {Promise<Object>} Created ticket record
 */
export async function createTicket(args = {}, context = {}) {
  const { title, description, category, priority } = args;
  const { user } = context;

  if (!user || !user.orgId || !user.userId) {
    throw new ToolExecutionError('Authenticated user context is required.');
  }

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    throw new ToolExecutionError("Argument 'title' is required to create a ticket.");
  }

  const normalizedCategory = category ? category.toUpperCase() : 'GENERAL';
  if (!TICKET_CATEGORIES.includes(normalizedCategory)) {
    throw new ToolExecutionError(
      `Invalid ticket category '${category}'. Allowed: ${TICKET_CATEGORIES.join(', ')}`
    );
  }

  const normalizedPriority = priority ? priority.toUpperCase() : 'MEDIUM';
  if (!TICKET_PRIORITIES.includes(normalizedPriority)) {
    throw new ToolExecutionError(
      `Invalid ticket priority '${priority}'. Allowed: ${TICKET_PRIORITIES.join(', ')}`
    );
  }

  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ticketId = `TICK-${Date.now().toString(36).toUpperCase()}-${randomSuffix}`;

  const ticket = await Ticket.create({
    ticketId,
    orgId: user.orgId,
    userId: user.userId,
    title: title.trim(),
    description: description ? description.trim() : '',
    category: normalizedCategory,
    priority: normalizedPriority,
    status: 'OPEN',
  });

  return {
    tool: 'createTicket',
    success: true,
    ticket: {
      ticketId: ticket.ticketId,
      title: ticket.title,
      description: ticket.description,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      createdAt: ticket.createdAt,
    },
    message: `Ticket ${ticket.ticketId} created successfully in ${normalizedCategory} category.`,
  };
}

/**
 * 5. applyLeave (Consequential / HITL Tool)
 * Validates leave balance against MongoDB, but DOES NOT alter balance immediately.
 * Stages an action token into Redis with a 15-minute TTL and returns an interactive approval card.
 *
 * @param {Object} args
 * @param {string} args.leaveType Type of leave: 'casual' | 'sick' | 'maternity'
 * @param {number} args.days Number of business days requested
 * @param {string} args.startDate Start date (YYYY-MM-DD)
 * @param {string} [args.endDate] End date (YYYY-MM-DD)
 * @param {string} [args.reason] Justification for leave
 * @param {Object} context Execution context with authenticated user
 * @returns {Promise<Object>} Staged HITL action card
 */
export async function applyLeave(args = {}, context = {}) {
  const { leaveType, days, startDate, endDate, reason } = args;
  const { user, redisClient } = context;

  if (!user || !user.orgId || !user.userId) {
    throw new ToolExecutionError('Authenticated user context is required.');
  }

  if (!leaveType || typeof leaveType !== 'string') {
    throw new ToolExecutionError("Argument 'leaveType' is required ('casual', 'sick', 'maternity').");
  }

  const normalizedType = leaveType.toLowerCase().trim();
  const allowedLeaveTypes = ['casual', 'sick', 'maternity'];
  if (!allowedLeaveTypes.includes(normalizedType)) {
    throw new ToolExecutionError(
      `Invalid leave type '${leaveType}'. Allowed: ${allowedLeaveTypes.join(', ')}`
    );
  }

  const parsedDays = parseInt(days, 10);
  if (isNaN(parsedDays) || parsedDays <= 0) {
    throw new ToolExecutionError("Argument 'days' must be a positive integer greater than zero.");
  }

  if (!startDate || typeof startDate !== 'string') {
    throw new ToolExecutionError("Argument 'startDate' is required (YYYY-MM-DD).");
  }

  // 1. Fetch user to verify active balance in MongoDB
  const employeeDoc = await User.findOne({
    userId: user.userId,
    orgId: user.orgId,
  }).select('userId name email department leaveBalances');

  if (!employeeDoc) {
    throw new ToolExecutionError(`User '${user.userId}' not found in organization.`, 404);
  }

  const currentBalance = employeeDoc.leaveBalances?.[normalizedType] ?? 0;

  if (currentBalance < parsedDays) {
    throw new ToolExecutionError(
      `Insufficient leave balance. You requested ${parsedDays} day(s) of ${normalizedType} leave, but only ${currentBalance} day(s) remain.`
    );
  }

  const newBalanceAfterApproval = currentBalance - parsedDays;

  // 2. Stage Action Token into Redis (15-min TTL) — NO MongoDB mutation occurs here!
  const staged = await stageActionToken({
    type: ACTION_TYPES.APPLY_LEAVE,
    userId: user.userId,
    orgId: user.orgId,
    payload: {
      leaveType: normalizedType,
      days: parsedDays,
      startDate: startDate.trim(),
      endDate: endDate ? endDate.trim() : startDate.trim(),
      reason: reason ? reason.trim() : '',
      currentBalance,
      newBalanceAfterApproval,
      userName: employeeDoc.name,
      department: employeeDoc.department,
    },
    summary: `Apply for ${parsedDays} day(s) of ${normalizedType} leave (${startDate}${endDate && endDate !== startDate ? ` to ${endDate}` : ''})`,
    client: redisClient,
  });

  return {
    tool: 'applyLeave',
    isConsequential: true,
    requiresConfirmation: true,
    actionId: staged.actionId,
    actionType: ACTION_TYPES.APPLY_LEAVE,
    card: staged.card,
    summary: staged.stagedAction.summary,
    message: `Leave application staged for confirmation. Please approve to deduct ${parsedDays} day(s) from your ${normalizedType} leave balance.`,
  };
}

/**
 * 6. requestHardwareUpgrade (Consequential / HITL Tool)
 * Inspects user's assigned hardware assets and stages a hardware upgrade requisition token in Redis.
 * Does NOT alter assets in MongoDB until human approval is received.
 *
 * @param {Object} args
 * @param {string} args.assetType Asset category ('LAPTOP', 'MONITOR', 'ACCESSORY', 'SOFTWARE_LICENSE')
 * @param {string} args.preferredModel Requested model specification
 * @param {string} args.reason Technical / business justification
 * @param {string} [args.urgency='MEDIUM'] Priority level ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
 * @param {Object} context Execution context with authenticated user
 * @returns {Promise<Object>} Staged HITL action card
 */
export async function requestHardwareUpgrade(args = {}, context = {}) {
  const { assetType, preferredModel, reason, urgency } = args;
  const { user, redisClient } = context;

  if (!user || !user.orgId || !user.userId) {
    throw new ToolExecutionError('Authenticated user context is required.');
  }

  if (!assetType || typeof assetType !== 'string') {
    throw new ToolExecutionError("Argument 'assetType' is required ('LAPTOP', 'MONITOR', etc.).");
  }

  const normalizedAssetType = assetType.toUpperCase().trim();
  if (!ASSET_TYPES.includes(normalizedAssetType)) {
    throw new ToolExecutionError(
      `Invalid asset category '${assetType}'. Allowed: ${ASSET_TYPES.join(', ')}`
    );
  }

  if (!preferredModel || typeof preferredModel !== 'string' || preferredModel.trim().length === 0) {
    throw new ToolExecutionError("Argument 'preferredModel' is required (e.g., 'MacBook Pro M3 Max').");
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ToolExecutionError("Argument 'reason' is required for hardware requisition justification.");
  }

  const normalizedUrgency = urgency ? urgency.toUpperCase().trim() : 'MEDIUM';
  if (!TICKET_PRIORITIES.includes(normalizedUrgency)) {
    throw new ToolExecutionError(
      `Invalid urgency level '${urgency}'. Allowed: ${TICKET_PRIORITIES.join(', ')}`
    );
  }

  // 1. Inspect existing assets assigned to the employee
  const currentAssets = await Asset.find({
    assignedTo: user.userId,
    orgId: user.orgId,
  }).select('assetTag type model status').lean();

  // 2. Stage Action Token into Redis (15-min TTL) — NO MongoDB mutation occurs here!
  const staged = await stageActionToken({
    type: ACTION_TYPES.REQUEST_HARDWARE_UPGRADE,
    userId: user.userId,
    orgId: user.orgId,
    payload: {
      assetType: normalizedAssetType,
      preferredModel: preferredModel.trim(),
      reason: reason.trim(),
      urgency: normalizedUrgency,
      currentAssets: currentAssets.map((a) => ({
        assetTag: a.assetTag,
        model: a.model,
        type: a.type,
      })),
      userName: user.name || user.userId,
      department: user.department || 'General',
    },
    summary: `Requisition for ${preferredModel.trim()} (${normalizedAssetType}) - Urgency: ${normalizedUrgency}`,
    client: redisClient,
  });

  return {
    tool: 'requestHardwareUpgrade',
    isConsequential: true,
    requiresConfirmation: true,
    actionId: staged.actionId,
    actionType: ACTION_TYPES.REQUEST_HARDWARE_UPGRADE,
    card: staged.card,
    summary: staged.stagedAction.summary,
    message: `Hardware upgrade request for ${preferredModel.trim()} staged for authorization.`,
  };
}

/**
 * Gemini Function Calling Declarations Schema
 * Enables Gemini Models (gemini-3.8-flash, gemini-3.5-flash) to trigger autonomous function calling.
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'searchPolicies',
    description: 'Search official ABC Technologies IT and HR company policy documentation in Qdrant.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'The search query or question regarding company policies, leave rules, or IT guidelines.',
        },
        department: {
          type: 'STRING',
          description: "Optional department filter (e.g. 'HR', 'IT').",
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'getLeaveBalance',
    description: "Retrieve an employee's remaining leave balances (casual, sick, maternity).",
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: {
          type: 'STRING',
          description: 'Optional employee ID. Defaults to the logged-in user.',
        },
      },
    },
  },
  {
    name: 'getMyTickets',
    description: 'Retrieve support tickets created by the logged-in employee.',
    parameters: {
      type: 'OBJECT',
      properties: {
        status: {
          type: 'STRING',
          description: "Optional status filter: 'OPEN', 'IN_PROGRESS', 'RESOLVED', or 'ALL'.",
        },
        limit: {
          type: 'INTEGER',
          description: 'Maximum number of tickets to return (default 10).',
        },
      },
    },
  },
  {
    name: 'createTicket',
    description: 'Create a new IT or HR support ticket in the organization.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: {
          type: 'STRING',
          description: 'Short title summarizing the support issue or request.',
        },
        description: {
          type: 'STRING',
          description: 'Detailed description of the issue.',
        },
        category: {
          type: 'STRING',
          enum: ['IT_HARDWARE', 'IT_ACCESS', 'HR_BENEFITS', 'HR_LEAVE', 'GENERAL'],
          description: 'Category of the support request.',
        },
        priority: {
          type: 'STRING',
          enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
          description: 'Priority level of the support ticket.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'applyLeave',
    description:
      'Stage a leave application for human confirmation. Checks balance and stages an approval card without altering database balance until approved.',
    parameters: {
      type: 'OBJECT',
      properties: {
        leaveType: {
          type: 'STRING',
          enum: ['casual', 'sick', 'maternity'],
          description: 'Type of leave to apply for.',
        },
        days: {
          type: 'INTEGER',
          description: 'Number of consecutive business days requested.',
        },
        startDate: {
          type: 'STRING',
          description: 'Start date in YYYY-MM-DD format.',
        },
        endDate: {
          type: 'STRING',
          description: 'Optional end date in YYYY-MM-DD format.',
        },
        reason: {
          type: 'STRING',
          description: 'Reason or justification for the leave request.',
        },
      },
      required: ['leaveType', 'days', 'startDate'],
    },
  },
  {
    name: 'requestHardwareUpgrade',
    description:
      'Stage a hardware upgrade requisition for manager/IT authorization. Checks existing hardware and returns a staged confirmation card.',
    parameters: {
      type: 'OBJECT',
      properties: {
        assetType: {
          type: 'STRING',
          enum: ['LAPTOP', 'MONITOR', 'ACCESSORY', 'SOFTWARE_LICENSE'],
          description: 'Category of hardware requested.',
        },
        preferredModel: {
          type: 'STRING',
          description: 'Specific hardware model or specification requested (e.g. MacBook Pro M3 Max).',
        },
        reason: {
          type: 'STRING',
          description: 'Business or technical justification for the hardware upgrade.',
        },
        urgency: {
          type: 'STRING',
          enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
          description: 'Urgency level of the request.',
        },
      },
      required: ['assetType', 'preferredModel', 'reason'],
    },
  },
];

/**
 * Universal Tool Dispatcher
 * Executes the registered tool by name with arguments and context.
 *
 * @param {string} toolName Name of the tool to execute
 * @param {Object} args Tool argument payload
 * @param {Object} context Execution context (user, redis, qdrant, embeddings)
 * @returns {Promise<Object>} Execution result
 */
export async function executeTool(toolName, args = {}, context = {}) {
  switch (toolName) {
    case 'searchPolicies':
      return await searchPolicies(args, context);
    case 'getLeaveBalance':
      return await getLeaveBalance(args, context);
    case 'getMyTickets':
      return await getMyTickets(args, context);
    case 'createTicket':
      return await createTicket(args, context);
    case 'applyLeave':
      return await applyLeave(args, context);
    case 'requestHardwareUpgrade':
      return await requestHardwareUpgrade(args, context);
    default:
      throw new InvalidToolError(toolName);
  }
}
