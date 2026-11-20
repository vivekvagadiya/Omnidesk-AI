import { Router } from 'express';
import authRouter from './auth.route.js';
import healthRouter from './health.route.js';
import copilotRouter from './copilot.route.js';
import ticketRouter from './ticket.route.js';
import profileRouter from './profile.route.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/copilot', copilotRouter);
router.use('/tickets', ticketRouter);
router.use('/profile', profileRouter);

export default router;
