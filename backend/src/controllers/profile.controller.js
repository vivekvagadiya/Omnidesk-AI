import { User } from "../models/User.model.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";

/**
 * Controller: Get Current User Leave Balance & Quotas
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

  try {
    let dbUser = null;
    if (typeof User.findOne === "function") {
      const query = User.findOne({ userId: user.userId, orgId: user.orgId });
      dbUser =
        typeof query.lean === "function" ? await query.lean() : await query;
    }

    const leaveBalances = dbUser?.leaveBalances || user.leaveBalances;

    return successResponse(res, {
      statusCode: 200,
      message: "Leave quota balance retrieved successfully.",
      data: {
        userId: user.userId,
        orgId: user.orgId,
        name: dbUser?.name || user.name || "Omnidesk User",
        email: dbUser?.email || user.email || "",
        role: dbUser?.role || user.role || "employee",
        department: dbUser?.department || user.department || "General",
        leaveBalances,
      },
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || "Failed to retrieve leave balance.",
    });
  }
}
