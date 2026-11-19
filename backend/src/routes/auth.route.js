import { Router } from 'express';
import {
  register,
  login,
  refreshToken,
  logout,
  getMe,
  forgotPasswordStub,
} from '../controllers/auth.controller.js';
import { authenticateJwt } from '../middlewares/auth.middleware.js';
import { authLimiter } from '../middlewares/rateLimiter.middleware.js';
import {
  validateSchema,
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  forgotPasswordSchema,
} from '../validators/auth.validator.js';

const router = Router();

// POST /api/auth/register - Register new corporate account
router.post('/register', authLimiter, validateSchema(registerSchema), register);

// POST /api/auth/login - Email + password authentication with dual tokens
router.post('/login', authLimiter, validateSchema(loginSchema), login);

// POST /api/auth/refresh - Rotate refresh token & mint new access token
router.post('/refresh', validateSchema(refreshTokenSchema), refreshToken);

// POST /api/auth/logout - Invalidate tokens & clear session
router.post('/logout', authenticateJwt, logout);

// GET /api/auth/me - Get currently authenticated user profile
router.get('/me', authenticateJwt, getMe);

// POST /api/auth/forgot-password - Visual stub for password reset
router.post('/forgot-password', authLimiter, validateSchema(forgotPasswordSchema), forgotPasswordStub);

export default router;
