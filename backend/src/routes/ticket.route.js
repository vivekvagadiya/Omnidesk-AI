import { Router } from 'express';
import { getTickets, createTicket } from '../controllers/ticket.controller.js';
import { authenticateJwt } from '../middlewares/auth.middleware.js';
import { cacheResponse, invalidateCache } from '../middlewares/cache.middleware.js';
import { CACHE_TTL } from '../services/cache/cache.service.js';

const router = Router();

// Enforce JWT authentication on all ticket routes
router.use(authenticateJwt);

/**
 * @route   GET /api/tickets
 * @desc    List tickets (scoped to user or all org tickets for Admin)
 * @access  Private (All Roles)
 * @cache   2-minute TTL per tenant user (Route-Level Declarative Middleware)
 */
router.get(
  '/',
  cacheResponse({ ttl: CACHE_TTL.TICKETS, tag: 'tickets', scope: 'user' }),
  getTickets
);

/**
 * @route   POST /api/tickets
 * @desc    Create a new support ticket (auto-invalidates tickets cache on 2xx)
 * @access  Private (All Roles)
 */
router.post(
  '/',
  invalidateCache(['tickets']),
  createTicket
);

export default router;
