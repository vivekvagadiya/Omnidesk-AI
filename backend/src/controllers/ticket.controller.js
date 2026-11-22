import * as ticketService from '../services/ticket.service.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';

// Exported so route-level cache and other consumers maintain seamless compatibility
export const ADMIN_ROLES = ticketService.ADMIN_ROLES;

/**
 * Controller: List Tickets (Thin Controller)
 * Pure Controller Logic (Delegates to ticket.service.js; caching handled by route-level cacheResponse middleware)
 * GET /api/tickets
 */
export async function getTickets(req, res, next) {
  try {
    const {
      status,
      category,
      priority,
      page,
      limit,
      userId,
    } = req.query;

    const data = await ticketService.getTicketsService({
      user: req.user,
      status,
      category,
      priority,
      page,
      limit,
      userId,
    });

    return successResponse(res, {
      statusCode: 200,
      message: 'Tickets retrieved successfully.',
      data,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: err.statusCode || 500,
      message: err.message || 'Failed to retrieve tickets.',
    });
  }
}

/**
 * Controller: Create Ticket (Thin Controller)
 * Pure Controller Logic (Delegates to ticket.service.js)
 * POST /api/tickets
 */
export async function createTicket(req, res, next) {
  try {
    const newTicket = await ticketService.createTicketService({
      user: req.user,
      ticketData: req.body,
    });

    return successResponse(res, {
      statusCode: 201,
      message: 'Ticket created successfully.',
      data: newTicket,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: err.statusCode || 500,
      message: err.message || 'Failed to create ticket.',
    });
  }
}

/**
 * Controller: Update Ticket (Thin Controller)
 * Pure Controller Logic (Delegates to ticket.service.js)
 * PATCH /api/tickets/:ticketId
 */
export async function updateTicket(req, res, next) {
  try {
    const { ticketId } = req.params;

    const updatedTicket = await ticketService.updateTicketService({
      user: req.user,
      ticketId,
      updateData: req.body,
    });

    return successResponse(res, {
      statusCode: 200,
      message: `Ticket ${ticketId} updated successfully.`,
      data: updatedTicket,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: err.statusCode || 500,
      message: err.message || 'Failed to update ticket.',
    });
  }
}
