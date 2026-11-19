import mongoose from 'mongoose';

export const ASSET_TYPES = ['LAPTOP', 'MONITOR', 'ACCESSORY', 'SOFTWARE_LICENSE'];

export const ASSET_STATUSES = ['IN_STOCK', 'ASSIGNED', 'MAINTENANCE', 'RETIRED'];

const assetSchema = new mongoose.Schema(
  {
    assetTag: {
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
    type: {
      type: String,
      enum: ASSET_TYPES,
      required: true,
      index: true,
    },
    model: {
      type: String,
      required: true,
      trim: true,
    },
    assignedTo: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ASSET_STATUSES,
      default: 'IN_STOCK',
      index: true,
    },
    cost: {
      type: Number,
      default: 0,
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

export const Asset = mongoose.model('Asset', assetSchema);
