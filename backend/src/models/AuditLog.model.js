import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    orgId: {
      type: String,
      required: true,
      trim: true,
    },
    actor: {
      userId: {
        type: String,
        required: true,
        trim: true,
      },
      name: {
        type: String,
        default: '',
        trim: true,
      },
      role: {
        type: String,
        default: 'employee',
        trim: true,
      },
    },
    action: {
      type: String,
      required: true,
      trim: true,
    },
    entity: {
      type: {
        type: String,
        default: null,
        trim: true,
      },
      id: {
        type: String,
        default: null,
        trim: true,
      },
    },
    changes: {
      before: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
      },
      after: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
      },
    },
    metadata: {
      ipAddress: {
        type: String,
        default: null,
        trim: true,
      },
      userAgent: {
        type: String,
        default: null,
        trim: true,
      },
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// Compound indexes for tenant isolation, actor, action, and chronological ordering
auditLogSchema.index({ orgId: 1, createdAt: -1 });
auditLogSchema.index({ orgId: 1, 'actor.userId': 1, createdAt: -1 });
auditLogSchema.index({ orgId: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ orgId: 1, 'actor.userId': 1, action: 1, createdAt: -1 });

// Safeguard append-only nature at model level
const preventMutation = function () {
  throw new Error('AuditLog is append-only: updates and deletions are not permitted.');
};

auditLogSchema.pre('updateOne', preventMutation);
auditLogSchema.pre('updateMany', preventMutation);
auditLogSchema.pre('findOneAndUpdate', preventMutation);
auditLogSchema.pre('replaceOne', preventMutation);
auditLogSchema.pre('deleteOne', preventMutation);
auditLogSchema.pre('deleteMany', preventMutation);
auditLogSchema.pre('findOneAndDelete', preventMutation);
auditLogSchema.pre('findOneAndRemove', preventMutation);

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
