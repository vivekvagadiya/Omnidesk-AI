import { Router } from 'express';
import { login, getMe, forgotPasswordStub } from '../controllers/auth.controller.js';
import { authenticateJwt } from '../middlewares/auth.middleware.js';

const router = Router();

// POST /api/auth/login - Email + password authentication
router.post('/login', login);

// GET /api/auth/me - Get currently authenticated user profile
router.get('/me', authenticateJwt, getMe);

// POST /api/auth/forgot-password - Visual stub for password reset
router.post('/forgot-password', forgotPasswordStub);

export default router;
