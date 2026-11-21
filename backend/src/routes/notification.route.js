import { Router } from 'express';
import { authenticateJwt } from '../middlewares/auth.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';
import {
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../controllers/notification.controller.js';

const router = Router();

router.use(authenticateJwt);

/**
 * @route   GET /api/notifications
 * @desc    Newest-first page of the user's notifications (cursor pagination)
 * @query   cursor, limit (max 50), unread=true
 */
router.get('/', getNotifications);

/**
 * @route   GET /api/notifications/unread-count
 * @desc    Badge counter. Polled by every open tab, so cached per user in Redis;
 *          invalidated whenever the user gets a notification or reads one.
 */
router.get('/unread-count', cacheResponse({ ttl: 60, tag: 'notifications', scope: 'user' }), getUnreadCount);

/**
 * @route   POST /api/notifications/read-all
 */
router.post('/read-all', markAllNotificationsRead);

/**
 * @route   PATCH /api/notifications/:notificationId/read
 */
router.patch('/:notificationId/read', markNotificationRead);

export default router;
