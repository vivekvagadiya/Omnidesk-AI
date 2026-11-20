import crypto from 'node:crypto';
import { Ticket, TICKET_CATEGORIES, TICKET_PRIORITIES } from '../models/Ticket.model.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';
import { invalidateTicketCaches } from '../services/cache/cache.service.js';
import { enqueueNotification } from '../services/queue/notificationWorker.js';

// Exported so the route-level cache resolves tags with the same visibility rules
export const ADMIN_ROLES = ['super_admin', 'org_admin', 'hr_admin', 'it_admin'];

/**
 * Controller: List Tickets
 * Pure Controller Logic (Caching handled declaratively by route-level cacheResponse middleware)
 * GET /api/tickets
 */
export async function getTickets(req, res) {
  const user = req.user;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Unauthorized: Valid user credentials required.',
    });
  }

  const { status, category, priority, page = 1, limit = 20, userId: filterUserId } = req.query;

  const query = {
    orgId: user.orgId,
  };

  const isAdmin = ADMIN_ROLES.includes(user.role);

  // Non-admin users can ONLY view their own tickets
  if (!isAdmin) {
    query.userId = user.userId;
  } else if (filterUserId && typeof filterUserId === 'string') {
    query.userId = filterUserId.trim();
  }

  if (status) query.status = status.toUpperCase();
  if (category) query.category = category.toUpperCase();
  if (priority) query.priority = priority.toUpperCase();

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  try {
    // Query MongoDB
    let tickets = [];
    let total = 0;

    if (typeof Ticket.find === 'function') {
      const execQuery = Ticket.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum);
      tickets = typeof execQuery.lean === 'function' ? await execQuery.lean() : await execQuery;
      total = typeof Ticket.countDocuments === 'function' ? await Ticket.countDocuments(query) : tickets.length;
    }

    const responseData = {
      tickets: tickets || [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: total || 0,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    };

    return successResponse(res, {
      statusCode: 200,
      message: 'Tickets retrieved successfully.',
      data: responseData,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Failed to retrieve tickets.',
    });
  }
}

/**
 * Controller: Create Ticket
 * Automatically flushes cached ticket lists for the tenant organization
 * POST /api/tickets
 */
export async function createTicket(req, res) {
  const user = req.user;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Unauthorized: Valid user credentials required.',
    });
  }

  const { title, description, category = 'GENERAL', priority = 'MEDIUM' } = req.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return errorResponse(res, {
      statusCode: 400,
      message: 'Ticket title is required.',
    });
  }

  const normalizedCategory = category.toUpperCase();
  const normalizedPriority = priority.toUpperCase();

  if (!TICKET_CATEGORIES.includes(normalizedCategory)) {
    return errorResponse(res, {
      statusCode: 400,
      message: `Invalid category '${category}'. Allowed: ${TICKET_CATEGORIES.join(', ')}`,
    });
  }

  if (!TICKET_PRIORITIES.includes(normalizedPriority)) {
    return errorResponse(res, {
      statusCode: 400,
      message: `Invalid priority '${priority}'. Allowed: ${TICKET_PRIORITIES.join(', ')}`,
    });
  }

  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ticketId = `TICK-${Date.now().toString(36).toUpperCase()}-${randomSuffix}`;

  try {
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

    // Refresh this user's ticket lists and the org-wide admin view
    await invalidateTicketCaches({ orgId: user.orgId, userId: user.userId });

    await enqueueNotification({
      event: 'TICKET_CREATED',
      ticketId,
      userId: user.userId,
      orgId: user.orgId,
      title: title.trim(),
      category: normalizedCategory,
      priority: normalizedPriority,
      createdAt: new Date().toISOString(),
    });

    return successResponse(res, {
      statusCode: 201,
      message: 'Ticket created successfully.',
      data: newTicket,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Failed to create ticket.',
    });
  }
}
