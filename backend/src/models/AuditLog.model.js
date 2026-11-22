import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    logId: {
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
    actorId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    actorName: {
      type: String,
      default: '',
    },
    actorRole: {
      type: String,
      default: 'employee',
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    entityId: {
      type: String,
      default: null,
      index: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    previousHash: {
      type: String,
      default: '0'.repeat(64),
    },
    hash: {
      type: String,
      required: true,
      index: true,
    },
    telemetry: {
      latencyMs: { type: Number, default: 0 },
      tokensUsed: {
        prompt: { type: Number, default: 0 },
        completion: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
      },
      model: { type: String, default: 'gemini-3.8-flash' },
      costUsd: { type: Number, default: 0 },
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
