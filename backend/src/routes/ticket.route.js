import { Router } from 'express';
import { getTickets, createTicket, ADMIN_ROLES } from '../controllers/ticket.controller.js';
import { authenticateJwt } from '../middlewares/auth.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';
import { CACHE_TTL, cacheTags } from '../services/cache/cache.service.js';

const router = Router();

// Enforce JWT authentication on all ticket routes
router.use(authenticateJwt);

/**
 * Which cached data does this ticket list depend on?
 * Mirrors the visibility rules in getTickets:
 *  - employees: always their own tickets
 *  - managers without a filter: themselves + direct reports
 *  - admins with ?userId=X: X's tickets
 *  - admins without a filter: the whole org
 */
function ticketListTags(req) {
  const { orgId, userId, role } = req.user;
  const isAdmin = ADMIN_ROLES.includes(role);
  const filterUserId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';

  if (isAdmin || role === 'manager') {
    if (filterUserId) return [cacheTags.user('tickets', orgId, filterUserId)];
    // Admin org view / manager team view: refreshed by any ticket change in the org
    return [cacheTags.org('tickets', orgId)];
  }
  return [cacheTags.user('tickets', orgId, userId)];
}

/**
 * @route   GET /api/tickets
 * @desc    List tickets (scoped to user or all org tickets for Admin)
 * @access  Private (All Roles)
 * @cache   2 min per user; invalidated whenever a ticket is created/approved for that user
 */
router.get(
  '/',
  cacheResponse({
    ttl: CACHE_TTL.TICKETS,
    tag: 'tickets',
    scope: 'user',
    // Must match the params getTickets reads; anything else is served uncached
    query: ['status', 'category', 'priority', 'page', 'limit', 'userId'],
    tags: ticketListTags,
  }),
  getTickets
);

/**
 * @route   POST /api/tickets
 * @desc    Create a new support ticket
 * @access  Private (All Roles)
 * @cache   Controller calls invalidateTicketCaches (same helper the chat tools use)
 */
router.post('/', createTicket);

export default router;
