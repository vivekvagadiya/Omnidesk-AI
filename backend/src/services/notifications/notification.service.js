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
 * Called inside the request that performed the action (after the DB write), so a
 * notification can't be lost the way a queued message can. It NEVER throws:
 * a notification failure must not fail a leave approval or ticket creation.
 *
 * @param {keyof notificationRules} event
 * @param {Object} payload Must include orgId and actor ({ userId, name })
 * @returns {Promise<number>} Number of notifications created
 */
export async function notify(event, payload) {
  const rule = notificationRules[event];
  if (!rule) {
    console.warn(`⚠️ [Notifications] No rule for event '${event}'`);
    return 0;
  }

  try {
    const notes = await rule(payload);
    if (!notes.length) return 0;

    const docs = notes.map((n) => ({
      notificationId: `ntf_${crypto.randomUUID()}`,
      orgId: payload.orgId,
      userId: n.userId,
      type: n.type,
      title: n.title,
      body: n.body || '',
      entity: n.entity || { kind: null, id: null },
      actorId: payload.actor?.userId || null,
      dedupeKey: `${n.type}:${n.entity?.id || 'none'}:${n.userId}`,
    }));

    let created = docs.length;
    try {
      await Notification.insertMany(docs, { ordered: false });
    } catch (err) {
      // Duplicate dedupeKey = this notification already exists (retry); anything else is real
      const writeErrors = err.writeErrors || [];
      const nonDuplicate = writeErrors.filter((e) => (e.code ?? e.err?.code) !== 11000);
      if (!writeErrors.length || nonDuplicate.length) throw err;
      created = docs.length - writeErrors.length;
    }

    await invalidateNotificationCaches({
      orgId: payload.orgId,
      userIds: [...new Set(docs.map((d) => d.userId))],
    });
    return created;
  } catch (err) {
    console.error(`⚠️ [Notifications] Failed to create '${event}' notifications: ${err.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Cursor = base64("<createdAt ISO>|<_id>") — stable even when new items arrive
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

export function countUnread({ orgId, userId }) {
  return Notification.countDocuments({ orgId, userId, readAt: null });
}

/**
 * Mark one notification read. Scoped to the recipient, so nobody can touch another
 * user's notifications. Idempotent.
 * @returns {Promise<boolean>} false when it doesn't exist for this user
 */
export async function markRead({ orgId, userId, notificationId }) {
  const doc = await Notification.findOneAndUpdate(
    { orgId, userId, notificationId },
    [{ $set: { readAt: { $ifNull: ['$readAt', '$$NOW'] } } }],
    { new: true }
  ).lean();

  if (!doc) return false;
  await invalidateNotificationCaches({ orgId, userIds: [userId] });
  return true;
}

/**
 * @returns {Promise<number>} How many were marked read
 */
export async function markAllRead({ orgId, userId }) {
  const result = await Notification.updateMany({ orgId, userId, readAt: null }, { $set: { readAt: new Date() } });
  if (result.modifiedCount) {
    await invalidateNotificationCaches({ orgId, userIds: [userId] });
  }
  return result.modifiedCount;
}
