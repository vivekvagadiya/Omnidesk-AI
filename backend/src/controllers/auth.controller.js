import { User } from '../models/User.model.js';
import { generateToken } from '../utils/jwt.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';
import { SEEDED_ACCOUNTS } from '../../scripts/seed.js';
import bcrypt from 'bcryptjs';

/**
 * Helper to find user from MongoDB or offline seed fallback
 */
async function findUserByEmail(email) {
  if (User.db?.readyState === 1) {
    return User.findOne({ email });
  }

  // Offline fallback to seeded corporate accounts
  const seedMatch = SEEDED_ACCOUNTS.find(
    (a) => a.email.toLowerCase() === email.toLowerCase()
  );

  if (!seedMatch) return null;

  return {
    ...seedMatch,
    comparePassword: async (pwd) => pwd === seedMatch.password,
    toSafeObject: () => {
      const copy = { ...seedMatch };
      delete copy.password;
      return copy;
    },
  };
}

async function findUserById(userId) {
  if (User.db?.readyState === 1) {
    return User.findOne({ userId });
  }

  const seedMatch = SEEDED_ACCOUNTS.find((a) => a.userId === userId);
  if (!seedMatch) return null;

  return {
    ...seedMatch,
    toSafeObject: () => {
      const copy = { ...seedMatch };
      delete copy.password;
      return copy;
    },
  };
}

/**
 * Handle corporate email + password login
 */
export async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return errorResponse(res, {
        statusCode: 400,
        message: 'Email and password are required.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Query user by email (MongoDB or offline fallback)
    const user = await findUserByEmail(normalizedEmail);

    if (!user) {
      return errorResponse(res, {
        statusCode: 401,
        message: 'Invalid credentials. User not found.',
      });
    }

    if (user.status && user.status !== 'ACTIVE') {
      return errorResponse(res, {
        statusCode: 403,
        message: 'This account has been deactivated. Please contact your Organization Admin.',
      });
    }

    // Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return errorResponse(res, {
        statusCode: 401,
        message: 'Invalid credentials. Incorrect password.',
      });
    }

    // Generate JWT token
    const tokenPayload = {
      userId: user.userId,
      name: user.name,
      email: user.email,
      role: user.role,
      orgId: user.orgId,
      department: user.department,
      managerId: user.managerId,
    };

    const token = generateToken(tokenPayload);

    return successResponse(res, {
      message: `Welcome back, ${user.name}!`,
      data: {
        token,
        user: user.toSafeObject(),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get currently authenticated user profile
 */
export async function getMe(req, res, next) {
  try {
    const user = await findUserById(req.user.userId);

    if (!user) {
      return errorResponse(res, {
        statusCode: 404,
        message: 'User profile not found.',
      });
    }

    return successResponse(res, {
      data: {
        user: user.toSafeObject(),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Visual Forgot Password Stub (no external SMTP required in Phase 1)
 */
export async function forgotPasswordStub(req, res, next) {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, {
        statusCode: 400,
        message: 'Company email is required.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await findUserByEmail(normalizedEmail);

    // Consistent timing/message to prevent user enumeration
    return successResponse(res, {
      message: `If an active corporate account exists for "${normalizedEmail}", a password reset link has been dispatched to your corporate inbox.`,
      data: {
        simulated: true,
        notice: 'Email dispatch simulated. Contact HR or Organization Admin for immediate password resets.',
      },
    });
  } catch (error) {
    next(error);
  }
}
