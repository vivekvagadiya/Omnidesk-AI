import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Notification } from '../../models/Notification.model.js';
import { invalidateNotificationCaches } from '../cache/cache.service.js';
import { notificationRules } from './notification.rules.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * Create in-app notifications for a domain event.
 *
 * Called synchronously in-process after the primary database transaction/write.
 * In-app notifications in MongoDB are the sole source of truth.
 *
 * Non-throwing: a notification failure must never crash or roll back the core business action.
 *
 * @param {keyof notificationRules} event
 * @param {Object} payload Must include orgId and actor ({ userId, name })
 * @returns {Promise<number>} Number of notifications created
 */
export async function notify(event, payload) {
  if (!payload?.orgId) {
    console.warn(`⚠️ [Notifications] Missing orgId in payload for event '${event}'`);
    return 0;
  }

  const rule = notificationRules[event];
  if (!rule) {
    console.warn(`⚠️ [Notifications] No rule registered for event '${event}'`);
    return 0;
  }

  try {
    const notes = await rule(payload);
    if (!notes || !notes.length) return 0;

    const docs = notes.map((n) => {
      // Deduplication strategy:
      // 1. If custom dedupeKey provided by rule, scope it by orgId.
      // 2. If entity has an id, deduplicate retries of this event on that entity for this user.
      // 3. For repeated events without a specific entity id, generate a unique key to allow distinct notifications.
      const dedupeKey = n.dedupeKey
        ? `${payload.orgId}:${n.dedupeKey}`
        : n.entity?.id
          ? `${payload.orgId}:${n.type}:${n.entity?.kind || 'entity'}:${n.entity.id}:${n.userId}`
          : `${payload.orgId}:${n.type}:${crypto.randomUUID()}:${n.userId}`;

      return {
        notificationId: `ntf_${crypto.randomUUID()}`,
        orgId: payload.orgId,
        userId: n.userId,
        type: n.type,
        title: n.title,
        body: n.body || '',
        entity: n.entity || { kind: null, id: null },
        actorId: payload.actor?.userId || null,
        dedupeKey,
      };
    });

    let created = docs.length;
    try {
      await Notification.insertMany(docs, { ordered: false });
    } catch (err) {
      // Duplicate key error (E11000) means an idempotent retry was detected
      const writeErrors = err.writeErrors || [];
      const nonDuplicate = writeErrors.filter((e) => (e.code ?? e.err?.code) !== 11000);
      if (!writeErrors.length || nonDuplicate.length) throw err;
      created = docs.length - writeErrors.length;
    }

    // Invalidate Redis unread badge count caches for recipients
    // Cache invalidation failure must NEVER make an already-persisted notification appear to have failed
    if (created > 0) {
      try {
        await invalidateNotificationCaches({
          orgId: payload.orgId,
          userIds: [...new Set(docs.map((d) => d.userId))],
        });
      } catch (cacheErr) {
        console.warn(`⚠️ [Notifications] Cache invalidation warning for org '${payload.orgId}': ${cacheErr.message}`);
      }
    }

    return created;
  } catch (err) {
    console.error(`⚠️ [Notifications] Failed to create '${event}' notifications: ${err.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Cursor = base64url("<createdAt ISO>|<_id>") — stable across pagination
// ---------------------------------------------------------------------------
function encodeCursor(doc) {
  return Buffer.from(`${doc.createdAt.toISOString()}|${doc._id}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || !mongoose.isValidObjectId(id)) return null;
    return { createdAt, _id: new mongoose.Types.ObjectId(id) };
  } catch {
    return null;
  }
}

function toDto(doc) {
  return {
    notificationId: doc.notificationId,
    type: doc.type,
    title: doc.title,
    body: doc.body,
    entity: doc.entity,
    actorId: doc.actorId,
    read: Boolean(doc.readAt),
    readAt: doc.readAt,
    createdAt: doc.createdAt,
  };
}

/**
 * Newest-first page of a user's notifications.
 *
 * @param {Object} params
 * @param {string} params.orgId Organization ID
 * @param {string} params.userId Recipient User ID
 * @param {string} [params.cursor] Pagination cursor from previous page
 * @param {number} [params.limit=20] Page limit (1-50)
 * @param {boolean} [params.unreadOnly=false] Filter to unread only
 * @returns {Promise<{ items: Object[], nextCursor: string|null }>}
 */
export async function listNotifications({ orgId, userId, cursor, limit = DEFAULT_PAGE_SIZE, unreadOnly = false }) {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE));
  const query = { orgId, userId };
  if (unreadOnly) query.readAt = null;

  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) {
      const err = new Error('Invalid cursor.');
      err.statusCode = 400;
      throw err;
    }
    query.$or = [{ createdAt: { $lt: c.createdAt } }, { createdAt: c.createdAt, _id: { $lt: c._id } }];
  }

  const docs = await Notification.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(pageSize + 1)
    .lean();

  const hasMore = docs.length > pageSize;
  const page = hasMore ? docs.slice(0, pageSize) : docs;
  return {
    items: page.map(toDto),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

/**
 * Count unread notifications for a user within an organization
 */
export function countUnread({ orgId, userId }) {
  return Notification.countDocuments({ orgId, userId, readAt: null });
}

/**
 * Mark one notification read. Scoped to the recipient for strict tenant & user isolation.
 *
 * @param {Object} params
 * @param {string} params.orgId Organization ID
 * @param {string} params.userId User ID
 * @param {string} params.notificationId Target notification ID
 * @returns {Promise<boolean>} true if found and updated, false otherwise
 */
export async function markRead({ orgId, userId, notificationId }) {
  const doc = await Notification.findOneAndUpdate(
    { orgId, userId, notificationId },
    [{ $set: { readAt: { $ifNull: ['$readAt', '$$NOW'] } } }],
    { new: true }
  ).lean();

  if (!doc) return false;

  // Cache invalidation failure must not fail the markRead response
  try {
    await invalidateNotificationCaches({ orgId, userIds: [userId] });
  } catch (cacheErr) {
    console.warn(`⚠️ [Notifications] Cache invalidation warning on markRead: ${cacheErr.message}`);
  }

  return true;
}

/**
 * Mark all notifications read for a user within an organization.
 *
 * @param {Object} params
 * @param {string} params.orgId Organization ID
 * @param {string} params.userId User ID
 * @returns {Promise<number>} Count of updated notifications
 */
export async function markAllRead({ orgId, userId }) {
  const result = await Notification.updateMany({ orgId, userId, readAt: null }, { $set: { readAt: new Date() } });

  if (result.modifiedCount > 0) {
    // Cache invalidation failure must not fail the markAllRead response
    try {
      await invalidateNotificationCaches({ orgId, userIds: [userId] });
    } catch (cacheErr) {
      console.warn(`⚠️ [Notifications] Cache invalidation warning on markAllRead: ${cacheErr.message}`);
    }
  }

  return result.modifiedCount;
}
