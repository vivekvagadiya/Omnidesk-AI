import * as authService from '../services/auth.service.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';

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
