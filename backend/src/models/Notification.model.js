import mongoose from 'mongoose';

export const NOTIFICATION_TYPES = [
  'TICKET_CREATED', // confirmation to the creator
  'TICKET_ASSIGNED_QUEUE', // new ticket in an admin's queue (IT/HR by category)
  'LEAVE_APPROVED', // employee's own leave executed
  'TEAM_LEAVE_APPROVED', // FYI to the employee's manager
  'HARDWARE_REQUESTED', // confirmation to the requester
  'HARDWARE_QUEUE', // new hardware request for IT admins
];

const NINETY_DAYS_SECONDS = 90 * 24 * 3600;

const notificationSchema = new mongoose.Schema(
  {
    notificationId: { type: String, required: true, unique: true, trim: true },
    orgId: { type: String, required: true, trim: true },
    userId: { type: String, required: true, trim: true }, // recipient
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, default: '', trim: true, maxlength: 1000 },
    // What the notification is about, so the UI can link to it
    entity: {
      kind: { type: String, enum: ['ticket', 'leave', null], default: null },
      id: { type: String, default: null },
    },
    actorId: { type: String, default: null }, // who caused it
    readAt: { type: Date, default: null },
    // event + entity + recipient: makes notify() idempotent if it is ever retried
    dedupeKey: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Bell list (newest first, cursor on createdAt + _id) and unread count
notificationSchema.index({ orgId: 1, userId: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ orgId: 1, userId: 1, readAt: 1 });
// Auto-delete after 90 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: NINETY_DAYS_SECONDS });

export const Notification = mongoose.model('Notification', notificationSchema);
