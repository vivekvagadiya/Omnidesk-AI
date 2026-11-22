import { User } from "../models/User.model.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";

/**
 * Controller: Get Leave Balance & Quotas
 * Supports caller's own balance or specified ?userId for Admins and Managers.
 * Pure Controller Logic (Caching handled declaratively by route-level cacheResponse middleware)
 * GET /api/profile/balance
 */
export async function getLeaveBalance(req, res) {
  const user = req.user;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: "Unauthorized: Valid user credentials required.",
    });
  }

  const requestedUserId =
    req.query?.userId && typeof req.query.userId === "string"
      ? req.query.userId.trim()
      : "";

  let targetUserId = user.userId;

  if (requestedUserId && requestedUserId !== user.userId) {
    // RBAC check: Only privileged roles can query other employees' leave balances
    const privilegedRoles = ["super_admin", "org_admin", "hr_admin", "manager"];
    if (!privilegedRoles.includes(user.role)) {
      return errorResponse(res, {
        statusCode: 403,
        message: `Access Denied: Role '${user.role}' lacks permission to view other users' leave balances.`,
      });
    }

    // If manager, verify that target user is a direct report
    if (user.role === "manager") {
      let isReport = false;
      if (typeof User.findOne === "function") {
        const query = User.findOne({
          orgId: user.orgId,
          userId: requestedUserId,
          managerId: user.userId,
        }).select("userId");
        isReport =
          typeof query.lean === "function" ? await query.lean() : await query;
      }
      if (!isReport) {
        return errorResponse(res, {
          statusCode: 403,
          message:
            "Access Denied: Managers can only view leave balances of their direct reports.",
        });
      }
    }

    targetUserId = requestedUserId;
  }

  try {
    // Query MongoDB
    let dbUser = null;
    if (typeof User.findOne === "function") {
      const query = User.findOne({ userId: targetUserId, orgId: user.orgId });
      dbUser =
        typeof query.lean === "function" ? await query.lean() : await query;
    }

    if (!dbUser && targetUserId !== user.userId) {
      return errorResponse(res, {
        statusCode: 404,
        message: `User '${targetUserId}' not found in this organization.`,
      });
    }

    const leaveBalances =
      dbUser?.leaveBalances ||
      (targetUserId === user.userId ? user.leaveBalances : null);
    const responseData = {
      userId: targetUserId,
      orgId: user.orgId,
      name:
        dbUser?.name ||
        (targetUserId === user.userId ? user.name : "Omnidesk User"),
      email: dbUser?.email || (targetUserId === user.userId ? user.email : ""),
      role:
        dbUser?.role || (targetUserId === user.userId ? user.role : "employee"),
      department:
        dbUser?.department ||
        (targetUserId === user.userId ? user.department : "General"),
      leaveBalances: leaveBalances || { casual: 0, sick: 0, maternity: 0 },
    };

    return successResponse(res, {
      statusCode: 200,
      message: "Leave quota balance retrieved successfully.",
      data: responseData,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || "Failed to retrieve leave balance.",
    });
  }
}
