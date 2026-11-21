import { successResponse, errorResponse } from '../utils/apiResponse.js';
import {
  listNotifications,
  countUnread,
  markRead,
  markAllRead,
} from '../services/notifications/notification.service.js';

/**
 * GET /api/notifications?cursor=&limit=20&unread=true
 */
export async function getNotifications(req, res) {
  const { orgId, userId } = req.user;
  const { cursor, limit, unread } = req.query;

  try {
    const page = await listNotifications({
      orgId,
      userId,
      cursor: typeof cursor === 'string' && cursor ? cursor : undefined,
      limit,
      unreadOnly: unread === 'true',
    });
    return successResponse(res, { message: 'Notifications retrieved.', data: page });
  } catch (err) {
    return errorResponse(res, {
      statusCode: err.statusCode || 500,
      message: err.statusCode ? err.message : 'Failed to retrieve notifications.',
    });
  }
}

/**
 * GET /api/notifications/unread-count
 */
export async function getUnreadCount(req, res) {
  const { orgId, userId } = req.user;
  try {
    const unread = await countUnread({ orgId, userId });
    return successResponse(res, { message: 'Unread count retrieved.', data: { unread } });
  } catch {
    return errorResponse(res, { statusCode: 500, message: 'Failed to count notifications.' });
  }
}

/**
 * PATCH /api/notifications/:notificationId/read
 */
export async function markNotificationRead(req, res) {
  const { orgId, userId } = req.user;
  const { notificationId } = req.params;

  try {
    const found = await markRead({ orgId, userId, notificationId });
    if (!found) {
      return errorResponse(res, { statusCode: 404, message: 'Notification not found.' });
    }
    return successResponse(res, { message: 'Notification marked as read.', data: { notificationId } });
  } catch {
    return errorResponse(res, { statusCode: 500, message: 'Failed to update notification.' });
  }
}

/**
 * POST /api/notifications/read-all
 */
export async function markAllNotificationsRead(req, res) {
  const { orgId, userId } = req.user;
  try {
    const updated = await markAllRead({ orgId, userId });
    return successResponse(res, { message: 'All notifications marked as read.', data: { updated } });
  } catch {
    return errorResponse(res, { statusCode: 500, message: 'Failed to update notifications.' });
  }
}
