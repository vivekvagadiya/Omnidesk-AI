import { Router } from 'express';
import { getTickets, createTicket } from '../controllers/ticket.controller.js';
import { authenticateJwt } from '../middlewares/auth.middleware.js';

const router = Router();

// Enforce JWT authentication on all ticket routes
router.use(authenticateJwt);

/**
 * @route   GET /api/tickets
 * @desc    List tickets (scoped to user or all org tickets for Admin)
 * @access  Private (All Roles)
 */
router.get('/', getTickets);

/**
 * @route   POST /api/tickets
 * @desc    Create a new support ticket
 * @access  Private (All Roles)
 */
router.post('/', createTicket);

export default router;
