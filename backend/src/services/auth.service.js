import bcrypt from 'bcryptjs';
import { User } from '../models/User.model.js';
import { generateToken } from '../utils/jwt.js';
import { SEEDED_ACCOUNTS } from '../../scripts/seed.js';

// Pre-computed dummy bcrypt hash to protect against timing attacks when user is not found
const DUMMY_HASH = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012';

// Pre-hashed seeded accounts cache using real bcrypt (10 rounds) for authentic verification
const PRE_HASHED_SEED_CACHE = SEEDED_ACCOUNTS.map((acc) => ({
  ...acc,
  passwordHash: bcrypt.hashSync(acc.password, 10),
}));

export class AuthServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'AuthServiceError';
    this.statusCode = statusCode;
  }
}

/**
 * Enterprise Password Strength Validator
 * Requires: Min 8 chars, at least 1 uppercase, 1 lowercase, 1 number, 1 special char
 */
export function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return { isValid: false, reason: 'Password is required and must be a string.' };
  }

  if (password.length < 8) {
    return { isValid: false, reason: 'Password must be at least 8 characters long.' };
  }

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password);

  if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
    return {
      isValid: false,
      reason: 'Password must include uppercase, lowercase, number, and special character.',
    };
  }

  return { isValid: true };
}

/**
 * Hash password securely using Bcrypt (10 salt rounds)
 */
export async function hashPassword(plainTextPassword) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plainTextPassword, salt);
}

/**
 * Compare plain text password against a bcrypt hash
 */
export async function verifyPassword(candidatePassword, passwordHash) {
  if (!candidatePassword || !passwordHash) return false;
  return bcrypt.compare(candidatePassword, passwordHash);
}

/**
 * Internal query helper: MongoDB first, with bcrypt-hashed seed fallback
 */
async function findUserRecordByEmail(email) {
  if (User.db?.readyState === 1) {
    return User.findOne({ email });
  }

  // Fallback with real bcrypt hashes
  const match = PRE_HASHED_SEED_CACHE.find(
    (a) => a.email.toLowerCase() === email.toLowerCase()
  );

  if (!match) return null;

  return {
    ...match,
    comparePassword: async (pwd) => bcrypt.compare(pwd, match.passwordHash),
    toSafeObject: () => {
      const copy = { ...match };
      delete copy.password;
      delete copy.passwordHash;
      return copy;
    },
  };
}

async function findUserRecordById(userId) {
  if (User.db?.readyState === 1) {
    return User.findOne({ userId });
  }

  const match = PRE_HASHED_SEED_CACHE.find((a) => a.userId === userId);
  if (!match) return null;

  return {
    ...match,
    toSafeObject: () => {
      const copy = { ...match };
      delete copy.password;
      delete copy.passwordHash;
      return copy;
    },
  };
}

/**
 * Authenticate employee using corporate email and bcrypt password verification
 *
 * @param {Object} credentials
 * @param {string} credentials.email Corporate email address
 * @param {string} credentials.password Plain text password
 * @returns {Promise<{ token: string, user: Object }>}
 */
export async function loginService({ email, password }) {
  if (!email || typeof email !== 'string' || !password) {
    throw new AuthServiceError('Corporate email and password are required.', 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await findUserRecordByEmail(normalizedEmail);

  // Timing-attack mitigation: run dummy bcrypt compare even if user not found
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH).catch(() => {});
    throw new AuthServiceError('Invalid corporate credentials. Account not found.', 401);
  }

  // Account status check
  if (user.status && user.status !== 'ACTIVE') {
    throw new AuthServiceError('This corporate account is deactivated. Contact HR or Organization Admin.', 403);
  }

  // Real Bcrypt password comparison
  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new AuthServiceError('Invalid corporate credentials. Incorrect password.', 401);
  }

  // Issue standard enterprise signed JWT
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
 * @returns {Promise<Object>} Safe user object
 */
export async function getMeService(userId) {
  if (!userId) {
    throw new AuthServiceError('User ID is required.', 400);
  }

  const user = await findUserRecordById(userId);

  if (!user) {
    throw new AuthServiceError('User profile not found.', 404);
  }

  return user.toSafeObject();
}

/**
 * Change employee password with strength validation and bcrypt re-hashing
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.oldPassword
 * @param {string} params.newPassword
 */
export async function changePasswordService({ userId, oldPassword, newPassword }) {
  if (!userId || !oldPassword || !newPassword) {
    throw new AuthServiceError('All fields (userId, oldPassword, newPassword) are required.', 400);
  }

  const strengthCheck = validatePasswordStrength(newPassword);
  if (!strengthCheck.isValid) {
    throw new AuthServiceError(`Weak password: ${strengthCheck.reason}`, 400);
  }

  let user = null;
  if (User.db?.readyState === 1) {
    user = await User.findOne({ userId });
  }

  if (!user) {
    throw new AuthServiceError('User not found to update password.', 404);
  }

  const isOldMatch = await user.comparePassword(oldPassword);
  if (!isOldMatch) {
    throw new AuthServiceError('Incorrect current password.', 401);
  }

  user.passwordHash = newPassword; // Mongoose pre-save hook will hash with bcrypt
  await user.save();

  return { success: true, message: 'Password successfully updated.' };
}

/**
 * Process password reset request stub
 *
 * @param {string} email
 * @returns {Promise<{ message: string, data: Object }>}
 */
export async function forgotPasswordService(email) {
  if (!email || typeof email !== 'string') {
    throw new AuthServiceError('Corporate email address is required.', 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  await findUserRecordByEmail(normalizedEmail);

  return {
    message: `If an active corporate account exists for "${normalizedEmail}", a password reset token has been dispatched to your corporate inbox.`,
    data: {
      simulated: true,
      securityNotice: 'Password reset dispatch simulated for corporate email audit.',
    },
  };
}
