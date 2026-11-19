import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export const USER_ROLES = [
  'super_admin',
  'org_admin',
  'hr_admin',
  'it_admin',
  'manager',
  'employee',
];

const userSchema = new mongoose.Schema(
  {
    userId: {
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
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
      select: false, // Never returned in normal queries
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
    refreshToken: {
      type: String,
      default: null,
      select: false, // Hidden by default
    },
    role: {
      type: String,
      enum: USER_ROLES,
      default: 'employee',
      index: true,
    },
    department: {
      type: String,
      required: true,
      default: 'General',
      trim: true,
    },
    managerId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    leaveBalances: {
      casual: { type: Number, default: 12, min: 0 },
      sick: { type: Number, default: 7, min: 0 },
      maternity: { type: Number, default: 90, min: 0 },
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
    },
  },
  {
    timestamps: true,
  }
);

// Pre-save hook: Hash password with 12 salt rounds before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    if (typeof next === 'function') return next();
    return;
  }

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    if (typeof next === 'function') next();
  } catch (err) {
    if (typeof next === 'function') next(err);
    else throw err;
  }
});

// Instance method to compare password securely
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!candidatePassword || !this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Safe JSON serialization (strips sensitive fields)
userSchema.methods.toSafeObject = function () {
  const obj = typeof this.toObject === 'function' ? this.toObject() : { ...this };
  delete obj.password;
  delete obj.refreshToken;
  delete obj.tokenVersion;
  delete obj.__v;
  return obj;
};

export const User = mongoose.model('User', userSchema);
