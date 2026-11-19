import mongoose from 'mongoose';

const organizationSchema = new mongoose.Schema(
  {
    orgId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    domain: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
    },
    settings: {
      allowedLeaveTypes: {
        type: [String],
        default: ['casual', 'sick', 'maternity', 'unpaid'],
      },
      maxConsecutiveLeaveWithoutApproval: {
        type: Number,
        default: 2,
      },
    },
  },
  {
    timestamps: true,
  }
);

export const Organization = mongoose.model('Organization', organizationSchema);
