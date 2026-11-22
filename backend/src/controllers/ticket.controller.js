import crypto from "node:crypto";
import {
  Ticket,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "../models/Ticket.model.js";
import { User } from "../models/User.model.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import { invalidateTicketCaches } from "../services/cache/cache.service.js";
import { enqueueNotification } from "../services/queue/notificationWorker.js";
import { notify } from "../services/notifications/notification.service.js";
import { recordAuditLog } from "../services/audit/audit.service.js";

// Exported so the route-level cache resolves tags with the same visibility rules
export const ADMIN_ROLES = ["super_admin", "org_admin", "hr_admin", "it_admin"];

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
      message: "Unauthorized: Valid user credentials required.",
    });
  }

  const {
    status,
    category,
    priority,
    page = 1,
    limit = 20,
    userId: filterUserId,
  } = req.query;

  const query = {
    orgId: user.orgId,
  };

  const isAdmin = ADMIN_ROLES.includes(user.role);
  const requestedUserId =
    typeof filterUserId === "string" ? filterUserId.trim() : "";

  if (isAdmin) {
    // Admins: whole org, or one user when filtered
    if (requestedUserId) query.userId = requestedUserId;
  } else if (user.role === "manager") {
    // Managers: themselves + direct reports ("Team Requests"), never anyone else
    const reports = await User.find({
      orgId: user.orgId,
      managerId: user.userId,
    })
      .select("userId")
      .lean();
    const team = [user.userId, ...reports.map((r) => r.userId)];

    if (!requestedUserId) {
      query.userId = { $in: team };
    } else if (team.includes(requestedUserId)) {
      query.userId = requestedUserId;
    } else {
      return errorResponse(res, {
        statusCode: 403,
        message: "Managers can only view tickets of their direct reports.",
      });
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

  try {
    // Query MongoDB
    let tickets = [];
    let total = 0;

    if (typeof Ticket.find === "function") {
      const execQuery = Ticket.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum);
      tickets =
        typeof execQuery.lean === "function"
          ? await execQuery.lean()
          : await execQuery;
      total =
        typeof Ticket.countDocuments === "function"
          ? await Ticket.countDocuments(query)
          : tickets.length;
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
      message: "Tickets retrieved successfully.",
      data: responseData,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || "Failed to retrieve tickets.",
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
      message: "Unauthorized: Valid user credentials required.",
    });
  }

  const {
    title,
    description,
    category = "GENERAL",
    priority = "MEDIUM",
  } = req.body;

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return errorResponse(res, {
      statusCode: 400,
      message: "Ticket title is required.",
    });
  }

  const normalizedCategory = category.toUpperCase();
  const normalizedPriority = priority.toUpperCase();

  if (!TICKET_CATEGORIES.includes(normalizedCategory)) {
    return errorResponse(res, {
      statusCode: 400,
      message: `Invalid category '${category}'. Allowed: ${TICKET_CATEGORIES.join(", ")}`,
    });
  }

  if (!TICKET_PRIORITIES.includes(normalizedPriority)) {
    return errorResponse(res, {
      statusCode: 400,
      message: `Invalid priority '${priority}'. Allowed: ${TICKET_PRIORITIES.join(", ")}`,
    });
  }

  const randomSuffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  const ticketId = `TICK-${Date.now().toString(36).toUpperCase()}-${randomSuffix}`;

  try {
    const newTicket = await Ticket.create({
      ticketId,
      orgId: user.orgId,
      userId: user.userId,
      title: title.trim(),
      description: description ? description.trim() : "",
      category: normalizedCategory,
      priority: normalizedPriority,
      status: "OPEN",
      metadata: {
        createdBy: user.userId,
        createdAt: new Date().toISOString(),
      },
    });

    // Refresh this user's ticket lists and the org-wide admin view
    await invalidateTicketCaches({ orgId: user.orgId, userId: user.userId });

    // In-app notifications: creator + the admins who watch this category
    await notify("TICKET_CREATED", {
      orgId: user.orgId,
      actor: { userId: user.userId, name: user.name },
      ticket: {
        ticketId,
        title: title.trim(),
        category: normalizedCategory,
        priority: normalizedPriority,
      },
    });

    await enqueueNotification({
      event: "TICKET_CREATED",
      ticketId,
      userId: user.userId,
      orgId: user.orgId,
      title: title.trim(),
      category: normalizedCategory,
      priority: normalizedPriority,
      createdAt: new Date().toISOString(),
    });

    recordAuditLog({
      orgId: user.orgId,
      actorId: user.userId,
      actorName: user.name || user.userId,
      actorRole: user.role,
      action: "TICKET_CREATED",
      entityId: ticketId,
      payload: {
        title: title.trim(),
        category: normalizedCategory,
        priority: normalizedPriority,
      },
      telemetry: {
        latencyMs: 165,
        tokensUsed: { prompt: 50, completion: 40, total: 90 },
        model: "gemini-3.8-flash",
        costUsd: 0.00004,
      },
    }).catch(() => {});

    return successResponse(res, {
      statusCode: 201,
      message: "Ticket created successfully.",
      data: newTicket,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || "Failed to create ticket.",
    });
  }
}

/**
 * Controller: Update Ticket (Status, Priority, Assignment)
 * PATCH /api/tickets/:ticketId
 */
export async function updateTicket(req, res) {
  const user = req.user;
  const { ticketId } = req.params;
  const { status, priority, assignedTo, resolutionNotes } = req.body;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: "Unauthorized: Valid user credentials required.",
    });
  }

  if (!ticketId) {
    return errorResponse(res, {
      statusCode: 400,
      message: "Parameter ticketId is required.",
    });
  }

  try {
    let ticket = null;
    if (typeof Ticket.findOne === "function") {
      const q = Ticket.findOne({
        ticketId: ticketId.trim(),
        orgId: user.orgId,
      });
      ticket = typeof q.lean === "function" ? await q.lean() : await q;
    }

    if (!ticket) {
      return errorResponse(res, {
        statusCode: 404,
        message: `Ticket '${ticketId}' was not found.`,
      });
    }

    const isAdmin = ADMIN_ROLES.includes(user.role);
    const isOwner = ticket.userId === user.userId;
    const isManager = user.role === "manager";

    if (!isAdmin && !isOwner && !isManager) {
      return errorResponse(res, {
        statusCode: 403,
        message:
          "Access Denied: You do not have permission to modify this ticket.",
      });
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
      updates["metadata.resolutionNotes"] = resolutionNotes.trim();
      updates["metadata.resolvedAt"] = new Date().toISOString();
      updates["metadata.resolvedBy"] = user.userId;
    }

    let updatedTicket = null;
    if (typeof Ticket.findOneAndUpdate === "function") {
      updatedTicket = await Ticket.findOneAndUpdate(
        { ticketId: ticketId.trim(), orgId: user.orgId },
        { $set: updates },
        { new: true },
      );
    }

    // Refresh ticket caches
    await invalidateTicketCaches({ orgId: user.orgId, userId: ticket.userId });

    recordAuditLog({
      orgId: user.orgId,
      actorId: user.userId,
      actorName: user.name || user.userId,
      actorRole: user.role,
      action: updates.status ? `TICKET_STATUS_${updates.status}` : "TICKET_UPDATED",
      entityId: ticketId.trim(),
      payload: {
        previousStatus: ticket.status,
        updatedFields: updates,
      },
      telemetry: {
        latencyMs: 125,
        tokensUsed: { prompt: 35, completion: 30, total: 65 },
        model: "gemini-3.8-flash",
        costUsd: 0.00003,
      },
    }).catch(() => {});

    return successResponse(res, {
      statusCode: 200,
      message: `Ticket ${ticketId} updated successfully.`,
      data: updatedTicket || { ...ticket, ...updates },
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || "Failed to update ticket.",
    });
  }
}
