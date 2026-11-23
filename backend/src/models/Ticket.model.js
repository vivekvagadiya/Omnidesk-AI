import mongoose from 'mongoose';

export const TICKET_CATEGORIES = [
  'IT_HARDWARE',
  'IT_ACCESS',
  'HR_BENEFITS',
  'HR_LEAVE',
  'GENERAL',
];

export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'PENDING_APPROVAL',
  'RESOLVED',
  'REJECTED',
];

const ticketSchema = new mongoose.Schema(
  {
    ticketId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    orgId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    category: {
      type: String,
      enum: TICKET_CATEGORIES,
      default: 'GENERAL',
      index: true,
    },
    priority: {
      type: String,
      enum: TICKET_PRIORITIES,
      default: 'MEDIUM',
      index: true,
    },
    status: {
      type: String,
      enum: TICKET_STATUSES,
      default: 'OPEN',
      index: true,
    },
    assignedTo: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    stagedActionId: {
      type: String,
      default: null,
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Enforce durable idempotency for staged actions at the database layer.
// Ensures that concurrent executions or retries of the same stagedActionId
// cannot create duplicate tickets or mutations under any circumstances.
ticketSchema.index(
  { orgId: 1, stagedActionId: 1 },
  {
    unique: true,
    partialFilterExpression: { stagedActionId: { $type: 'string' } },
  }
);

export const Ticket = mongoose.model('Ticket', ticketSchema);
