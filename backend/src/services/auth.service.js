import { User } from '../models/User.model.js';
import { generateToken } from '../utils/jwt.js';
import { SEEDED_ACCOUNTS } from '../../scripts/seed.js';

class ServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Helper to query user from MongoDB or fallback to seeded corporate accounts
 */
async function findUserByEmail(email) {
  if (User.db?.readyState === 1) {
    return User.findOne({ email });
  }

  // Offline/Dev fallback to seeded accounts
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
 * Authenticate employee with email and password
 *
 * @param {Object} credentials
 * @param {string} credentials.email
 * @param {string} credentials.password
 * @returns {Promise<{ token: string, user: Object }>}
 */
export async function loginService({ email, password }) {
  if (!email || !password) {
    throw new ServiceError('Email and password are required.', 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await findUserByEmail(normalizedEmail);

  if (!user) {
    throw new ServiceError('Invalid credentials. User not found.', 401);
  }

  if (user.status && user.status !== 'ACTIVE') {
    throw new ServiceError('This account has been deactivated. Please contact your Organization Admin.', 403);
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new ServiceError('Invalid credentials. Incorrect password.', 401);
  }

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

  return {
    token,
    user: user.toSafeObject(),
  };
}

/**
 * Retrieve authenticated employee profile by userId
 *
 * @param {string} userId
 * @returns {Promise<Object>}
 */
export async function getMeService(userId) {
  const user = await findUserById(userId);

  if (!user) {
    throw new ServiceError('User profile not found.', 404);
  }

  return user.toSafeObject();
}

/**
 * Process password reset request stub
 *
 * @param {string} email
 * @returns {Promise<{ message: string, data: Object }>}
 */
export async function forgotPasswordService(email) {
  if (!email) {
    throw new ServiceError('Company email is required.', 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  await findUserByEmail(normalizedEmail);

  return {
    message: `If an active corporate account exists for "${normalizedEmail}", a password reset link has been dispatched to your corporate inbox.`,
    data: {
      simulated: true,
      notice: 'Email dispatch simulated. Contact HR or Organization Admin for immediate password resets.',
    },
  };
}
