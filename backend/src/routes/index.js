import { Router } from 'express';
import authRouter from './auth.route.js';
import healthRouter from './health.route.js';
import copilotRouter from './copilot.route.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/copilot', copilotRouter);

export default router;
