import { User } from '../models/User.model.js';

export class ProfileServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'ProfileServiceError';
    this.statusCode = statusCode;
  }
}

/**
 * Service: Retrieve leave balance and quotas for an employee
 * Enforces strict enterprise RBAC:
 * - Employees can only query their own leave balance.
 * - Managers can only query direct reports.
 * - Admins (super_admin, org_admin, hr_admin) can query any user in the organization.
 *
 * @param {Object} params
 * @param {Object} params.user Authenticated user context
 * @param {string} [params.requestedUserId] Optional target user ID
 * @returns {Promise<Object>} Safe leave balance payload
 */
export async function getLeaveBalanceService({ user, requestedUserId }) {
  if (!user || !user.orgId) {
    throw new ProfileServiceError('Unauthorized: Valid user credentials required.', 401);
  }

  const cleanRequestedId =
    typeof requestedUserId === 'string' && requestedUserId.trim().length > 0
      ? requestedUserId.trim()
      : '';

  let targetUserId = user.userId;

  if (cleanRequestedId && cleanRequestedId !== user.userId) {
    // RBAC check: Only privileged roles can query other employees' leave balances
    const privilegedRoles = ['super_admin', 'org_admin', 'hr_admin', 'manager'];
    if (!privilegedRoles.includes(user.role)) {
      throw new ProfileServiceError(
        `Access Denied: Role '${user.role}' lacks permission to view other users' leave balances.`,
        403
      );
    }

    // If manager, verify that target user is a direct report
    if (user.role === 'manager') {
      let isReport = false;
      if (typeof User.findOne === 'function') {
        const query = User.findOne({
          orgId: user.orgId,
          userId: cleanRequestedId,
          managerId: user.userId,
        }).select('userId');
        isReport = typeof query.lean === 'function' ? await query.lean() : await query;
      }
      if (!isReport) {
        throw new ProfileServiceError(
          'Access Denied: Managers can only view leave balances of their direct reports.',
          403
        );
      }
    }

    targetUserId = cleanRequestedId;
  }

  // Query database
  let dbUser = null;
  if (typeof User.findOne === 'function') {
    const query = User.findOne({ userId: targetUserId, orgId: user.orgId });
    dbUser = typeof query.lean === 'function' ? await query.lean() : await query;
  }

  if (!dbUser && targetUserId !== user.userId) {
    throw new ProfileServiceError(`User '${targetUserId}' not found in this organization.`, 404);
  }

  const leaveBalances =
    dbUser?.leaveBalances ||
    (targetUserId === user.userId ? user.leaveBalances : null);

  return {
    userId: targetUserId,
    orgId: user.orgId,
    name:
      dbUser?.name ||
      (targetUserId === user.userId ? user.name : 'Omnidesk User'),
    email: dbUser?.email || (targetUserId === user.userId ? user.email : ''),
    role:
      dbUser?.role || (targetUserId === user.userId ? user.role : 'employee'),
    department:
      dbUser?.department ||
      (targetUserId === user.userId ? user.department : 'General'),
    leaveBalances: leaveBalances || { casual: 0, sick: 0, maternity: 0 },
  };
}
