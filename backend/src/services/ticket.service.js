import crypto from 'node:crypto';
import {
  Ticket,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '../models/Ticket.model.js';
import { User } from '../models/User.model.js';
import { invalidateTicketCaches } from './cache/cache.service.js';
import { notify } from './notifications/notification.service.js';
import { recordAuditLog } from './audit/audit.service.js';

export const ADMIN_ROLES = ['super_admin', 'org_admin', 'hr_admin', 'it_admin'];

export class TicketServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'TicketServiceError';
    this.statusCode = statusCode;
  }
}

/**
 * Service: List tickets scoped by tenant and caller role
 */
export async function getTicketsService({
  user,
  status,
  category,
  priority,
  page = 1,
  limit = 20,
  userId: filterUserId,
}) {
  if (!user || !user.orgId) {
    throw new TicketServiceError('Unauthorized: Valid user credentials required.', 401);
  }

  const query = {
    orgId: user.orgId,
  };

  const isAdmin = ADMIN_ROLES.includes(user.role);
  const requestedUserId =
    typeof filterUserId === 'string' ? filterUserId.trim() : '';

  if (isAdmin) {
    // Admins: whole org, or one user when filtered
    if (requestedUserId) query.userId = requestedUserId;
  } else if (user.role === 'manager') {
    // Managers: themselves + direct reports ("Team Requests"), never anyone else
    const reports = await User.find({
      orgId: user.orgId,
      managerId: user.userId,
    })
      .select('userId')
      .lean();
    const team = [user.userId, ...reports.map((r) => r.userId)];

    if (!requestedUserId) {
      query.userId = { $in: team };
    } else if (team.includes(requestedUserId)) {
      query.userId = requestedUserId;
    } else {
      throw new TicketServiceError(
        'Managers can only view tickets of their direct reports.',
        403
      );
    }
  } else {
    // Employees can ONLY view their own tickets
    query.userId = user.userId;
  }

  if (status) query.status = status.toUpperCase();
  if (category) query.category = category.toUpperCase();
  if (priority) query.priority = priority.toUpperCase();

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  let tickets = [];
  let total = 0;

  if (typeof Ticket.find === 'function') {
    const execQuery = Ticket.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    tickets =
      typeof execQuery.lean === 'function'
        ? await execQuery.lean()
        : await execQuery;
    total =
      typeof Ticket.countDocuments === 'function'
        ? await Ticket.countDocuments(query)
        : tickets.length;
  }

  return {
    tickets: tickets || [],
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: total || 0,
      totalPages: Math.ceil(total / limitNum) || 1,
    },
  };
}

/**
 * Service: Create a new support ticket
 */
export async function createTicketService({ user, ticketData }) {
  if (!user || !user.orgId) {
    throw new TicketServiceError('Unauthorized: Valid user credentials required.', 401);
  }

  const {
    title,
    description,
    category = 'GENERAL',
    priority = 'MEDIUM',
  } = ticketData || {};

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    throw new TicketServiceError('Ticket title is required.', 400);
  }

  const normalizedCategory = category.toUpperCase();
  const normalizedPriority = priority.toUpperCase();

  if (!TICKET_CATEGORIES.includes(normalizedCategory)) {
    throw new TicketServiceError(
      `Invalid category '${category}'. Allowed: ${TICKET_CATEGORIES.join(', ')}`,
      400
    );
  }

  if (!TICKET_PRIORITIES.includes(normalizedPriority)) {
    throw new TicketServiceError(
      `Invalid priority '${priority}'. Allowed: ${TICKET_PRIORITIES.join(', ')}`,
      400
    );
  }

  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ticketId = `TICK-${Date.now().toString(36).toUpperCase()}-${randomSuffix}`;

  const newTicket = await Ticket.create({
    ticketId,
    orgId: user.orgId,
    userId: user.userId,
    title: title.trim(),
    description: description ? description.trim() : '',
    category: normalizedCategory,
    priority: normalizedPriority,
    status: 'OPEN',
    metadata: {
      createdBy: user.userId,
      createdAt: new Date().toISOString(),
    },
  });

  // Invalidate ticket caches
  await invalidateTicketCaches({ orgId: user.orgId, userId: user.userId });

  // In-app notifications: creator + the admins who watch this category
  await notify('TICKET_CREATED', {
    orgId: user.orgId,
    actor: { userId: user.userId, name: user.name },
    ticket: {
      ticketId,
      title: title.trim(),
      category: normalizedCategory,
      priority: normalizedPriority,
    },
  });

  recordAuditLog({
    orgId: user.orgId,
    actor: {
      userId: user.userId,
      name: user.name || user.userId,
      role: user.role,
    },
    action: 'TICKET_CREATED',
    entity: {
      type: 'ticket',
      id: ticketId,
    },
    changes: {
      after: {
        title: title.trim(),
        category: normalizedCategory,
        priority: normalizedPriority,
      },
    },
  }).catch(() => {});

  return newTicket;
}

/**
 * Service: Update Ticket (Status, Priority, Assignment, Resolution)
 */
export async function updateTicketService({ user, ticketId, updateData }) {
  if (!user || !user.orgId) {
    throw new TicketServiceError('Unauthorized: Valid user credentials required.', 401);
  }

  if (!ticketId || typeof ticketId !== 'string') {
    throw new TicketServiceError('Parameter ticketId is required.', 400);
  }

  const { status, priority, assignedTo, resolutionNotes } = updateData || {};

  let ticket = null;
  if (typeof Ticket.findOne === 'function') {
    const q = Ticket.findOne({
      ticketId: ticketId.trim(),
      orgId: user.orgId,
    });
    ticket = typeof q.lean === 'function' ? await q.lean() : await q;
  }

  if (!ticket) {
    throw new TicketServiceError(`Ticket '${ticketId}' was not found.`, 404);
  }

  const isAdmin = ADMIN_ROLES.includes(user.role);
  const isOwner = ticket.userId === user.userId;
  const isManager = user.role === 'manager';

  if (!isAdmin && !isOwner && !isManager) {
    throw new TicketServiceError(
      'Access Denied: You do not have permission to modify this ticket.',
      403
    );
  }

  const updates = {};
  if (status && TICKET_STATUSES.includes(status.toUpperCase())) {
    updates.status = status.toUpperCase();
  }
  if (
    priority &&
    TICKET_PRIORITIES.includes(priority.toUpperCase()) &&
    (isAdmin || isManager)
  ) {
    updates.priority = priority.toUpperCase();
  }
  if (assignedTo !== undefined && (isAdmin || isManager)) {
    updates.assignedTo = assignedTo ? assignedTo.trim() : null;
  }
  if (resolutionNotes) {
    updates['metadata.resolutionNotes'] = resolutionNotes.trim();
    updates['metadata.resolvedAt'] = new Date().toISOString();
    updates['metadata.resolvedBy'] = user.userId;
  }

  let updatedTicket = null;
  if (typeof Ticket.findOneAndUpdate === 'function') {
    updatedTicket = await Ticket.findOneAndUpdate(
      { ticketId: ticketId.trim(), orgId: user.orgId },
      { $set: updates },
      { new: true }
    );
  }

  // Refresh ticket caches
  await invalidateTicketCaches({ orgId: user.orgId, userId: ticket.userId });

  recordAuditLog({
    orgId: user.orgId,
    actor: {
      userId: user.userId,
      name: user.name || user.userId,
      role: user.role,
    },
    action: updates.status ? `TICKET_STATUS_${updates.status}` : 'TICKET_UPDATED',
    entity: {
      type: 'ticket',
      id: ticketId.trim(),
    },
    changes: {
      before: { status: ticket.status },
      after: updates,
    },
  }).catch(() => {});

  return updatedTicket || { ...ticket, ...updates };
}
