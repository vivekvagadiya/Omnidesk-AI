import bcrypt from 'bcryptjs';
import { User } from '../models/User.model.js';
import { generateTokens, verifyRefreshToken } from '../utils/jwt.js';

// Pre-computed bcrypt hash (12 salt rounds) to prevent timing attacks on nonexistent accounts
const DUMMY_HASH = '$2a$12$e8rOqfIe7Z9V3P7l4J3zkuR8J4uJv6W1xPzHq7t0s1o2n3m4l5k6j';

export class AuthServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'AuthServiceError';
    this.statusCode = statusCode;
  }
}

/**
 * Enterprise Password Strength Validator
 * Requires: Min 8 chars, at least 1 uppercase, 1 lowercase, 1 number
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

  if (!hasUpper || !hasLower || !hasDigit) {
    return {
      isValid: false,
      reason: 'Password must include uppercase, lowercase, and numeric characters.',
    };
  }

  return { isValid: true };
}

/**
 * Hash password securely using Bcrypt (12 salt rounds)
 */
export async function hashPassword(plainTextPassword) {
  const salt = await bcrypt.genSalt(12);
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
 * Register a new employee in the organization
 *
 * @param {Object} userData
 * @returns {Promise<Object>} Safe user profile
 */
export async function registerService(userData) {
  const { name, email, password, orgId, department, role, managerId, userId } = userData;

  if (!email || !password || !name) {
    throw new AuthServiceError('Name, corporate email, and password are required.', 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new AuthServiceError('Corporate user with this email already exists.', 400);
  }

  const generatedUserId = userId || `emp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const user = new User({
    userId: generatedUserId,
    orgId: orgId || 'org_abc',
    name: name.trim(),
    email: normalizedEmail,
    password, // Mongoose pre-save hook automatically hashes with bcrypt (12 rounds)
    role: role || 'employee',
    department: department || 'General',
    managerId: managerId || null,
    status: 'ACTIVE',
    tokenVersion: 0,
  });

  await user.save();
  return user.toSafeObject();
}

/**
 * Authenticate employee using corporate email and bcrypt password verification
 * Implements dual-token issuance (15m Access Token + 7d Refresh Token)
 * and tokenVersion incrementation for instant revocation.
 *
 * @param {Object} credentials
 * @param {string} credentials.email Corporate email address
 * @param {string} credentials.password Plain text password
 * @returns {Promise<{ user: Object, accessToken: string, refreshToken: string }>}
 */
export async function loginService({ email, password }) {
  if (!email || typeof email !== 'string' || !password) {
    throw new AuthServiceError('Corporate email and password are required.', 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await User.findOne({ email: normalizedEmail }).select('+password +refreshToken');

  // Timing-attack mitigation: run dummy bcrypt compare even if user not found
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH).catch(() => {});
    throw new AuthServiceError('Invalid corporate credentials.', 401);
  }

  // Account status check
  if (user.status !== 'ACTIVE') {
    throw new AuthServiceError('This corporate account is deactivated. Contact HR or Organization Admin.', 403);
  }

  // Bcrypt password comparison
  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new AuthServiceError('Invalid corporate credentials.', 401);
  }

  // Bump tokenVersion to invalidate older access tokens across all sessions
  user.tokenVersion = (user.tokenVersion || 0) + 1;

  // Mint dual tokens (15m Access Token + 7d Refresh Token)
  const { accessToken, refreshToken } = generateTokens(user);

  // Store refresh token in MongoDB
  user.refreshToken = refreshToken;
  await user.save();

  return {
    user: user.toSafeObject(),
    accessToken,
    refreshToken,
  };
}

/**
 * Rotate Refresh Token and generate a fresh Access Token
 *
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string, refreshToken: string }>}
 */
export async function refreshTokenService(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    throw new AuthServiceError('Refresh token is required.', 400);
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (err) {
    throw new AuthServiceError('Invalid or expired refresh token.', 401);
  }

  const user = await User.findOne({ userId: decoded.userId }).select('+refreshToken');
  if (!user) {
    throw new AuthServiceError('User not found for refresh token.', 401);
  }

  if (user.status !== 'ACTIVE') {
    throw new AuthServiceError('This corporate account is deactivated.', 403);
  }

  // Refresh token mismatch protection (replay/theft defense)
  if (!user.refreshToken || user.refreshToken !== refreshToken) {
    throw new AuthServiceError('Refresh token mismatch or already rotated.', 401);
  }

  // Token version verification
  if (decoded.version !== undefined && decoded.version !== user.tokenVersion) {
    throw new AuthServiceError('Token has been revoked.', 401);
  }

  // Mint fresh dual tokens
  const tokens = generateTokens(user);
  user.refreshToken = tokens.refreshToken;
  await user.save();

  return tokens;
}

/**
 * Revoke tokens and log out user
 * Clears stored refreshToken and increments tokenVersion in MongoDB
 *
 * @param {string} userId
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function logoutService(userId) {
  if (!userId) {
    throw new AuthServiceError('User ID is required.', 400);
  }

  await User.updateOne(
    { userId },
    {
      $set: { refreshToken: null },
      $inc: { tokenVersion: 1 },
    }
  );

  return { success: true, message: 'Logged out successfully.' };
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

  const user = await User.findOne({ userId }).select('-password -refreshToken -tokenVersion');

  if (!user) {
    throw new AuthServiceError('User profile not found.', 404);
  }

  return user.toSafeObject ? user.toSafeObject() : user;
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
  await User.findOne({ email: normalizedEmail }).catch(() => {});

  return {
    message: `If an active corporate account exists for "${normalizedEmail}", a password reset token has been dispatched to your corporate inbox.`,
    data: {
      simulated: true,
      securityNotice: 'Password reset dispatch simulated for corporate email audit.',
    },
  };
}
