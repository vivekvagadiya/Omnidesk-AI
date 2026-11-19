import * as authService from '../services/auth.service.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';

/**
 * Handle corporate user registration (Thin Controller)
 */
export async function register(req, res, next) {
  try {
    const user = await authService.registerService(req.body);

    return successResponse(res, {
      statusCode: 201,
      message: 'Corporate user registered successfully.',
      data: { user },
    });
  } catch (error) {
    if (error.statusCode) {
      return errorResponse(res, {
        statusCode: error.statusCode,
        message: error.message,
      });
    }
    next(error);
  }
}

/**
 * Handle corporate email + password login (Thin Controller)
 */
export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const result = await authService.loginService({ email, password });

    return successResponse(res, {
      message: `Welcome back, ${result.user.name}!`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return errorResponse(res, {
        statusCode: error.statusCode,
        message: error.message,
      });
    }
    next(error);
  }
}

/**
 * Refresh access token using long-lived refresh token (Thin Controller)
 */
export async function refreshToken(req, res, next) {
  try {
    const { refreshToken: token } = req.body;
    const result = await authService.refreshTokenService(token);

    return successResponse(res, {
      message: 'Tokens rotated successfully.',
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return errorResponse(res, {
        statusCode: error.statusCode,
        message: error.message,
      });
    }
    next(error);
  }
}

/**
 * Revoke session and log out (Thin Controller)
 */
export async function logout(req, res, next) {
  try {
    const result = await authService.logoutService(req.user.userId);

    return successResponse(res, {
      message: result.message,
    });
  } catch (error) {
    if (error.statusCode) {
      return errorResponse(res, {
        statusCode: error.statusCode,
        message: error.message,
      });
    }
    next(error);
  }
}

/**
 * Get currently authenticated user profile (Thin Controller)
 */
export async function getMe(req, res, next) {
  try {
    const user = await authService.getMeService(req.user.userId);

    return successResponse(res, {
      data: { user },
    });
  } catch (error) {
    if (error.statusCode) {
      return errorResponse(res, {
        statusCode: error.statusCode,
        message: error.message,
      });
    }
    next(error);
  }
}

/**
 * Visual Forgot Password Stub (Thin Controller)
 */
export async function forgotPasswordStub(req, res, next) {
  try {
    const { email } = req.body;
    const result = await authService.forgotPasswordService(email);

    return successResponse(res, {
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    if (error.statusCode) {
      return errorResponse(res, {
        statusCode: error.statusCode,
        message: error.message,
      });
    }
    next(error);
  }
}
