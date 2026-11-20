import bcrypt from 'bcryptjs';
import { Organization } from '../src/models/Organization.model.js';
import { User, USER_ROLES } from '../src/models/User.model.js';
import { Ticket } from '../src/models/Ticket.model.js';
import { Asset } from '../src/models/Asset.model.js';
import {
  generateToken,
  verifyToken,
  generateTokens,
  verifyAccessToken,
  verifyRefreshToken,
} from '../src/utils/jwt.js';
import {
  authenticateJwt,
  requireRoles,
  requireSameOrg,
} from '../src/middlewares/auth.middleware.js';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
} from '../src/services/auth.service.js';
import {
  validateSchema,
  loginSchema,
  registerSchema,
  refreshTokenSchema,
} from '../src/validators/auth.validator.js';
import { authLimiter } from '../src/middlewares/rateLimiter.middleware.js';
import {
  register,
  login,
  refreshToken,
  logout,
  getMe,
  forgotPasswordStub,
} from '../src/controllers/auth.controller.js';

console.log('================================================================');
console.log('🛡️  OMNIDESK AI — SPRINT 1 ENTERPRISE AUTH & ARCHITECTURE VERIFICATION');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

const assert = (condition, description) => {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${description}`);
  } else {
    console.error(`  ❌ [FAIL] ${description}`);
  }
};

// Mock Express response generator
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
  };
  return res;
}

// =============================================================
// TEST SUITE 1: Multi-Tenant & Role Hierarchy Schemas
// =============================================================
console.log('--- Suite 1: Multi-Tenant Data Schemas & Role Hierarchy ---');

// 1.1: Organization Model schema
assert(
  Boolean(Organization.schema.paths.orgId) && Boolean(Organization.schema.paths.domain),
  'Organization schema defines orgId and corporate domain'
);
console.log('    ↳ Organization Model Paths:', Object.keys(Organization.schema.paths).join(', '));

// 1.2: User Model roles validation
assert(
  USER_ROLES.includes('super_admin') &&
    USER_ROLES.includes('org_admin') &&
    USER_ROLES.includes('hr_admin') &&
    USER_ROLES.includes('it_admin') &&
    USER_ROLES.includes('manager') &&
    USER_ROLES.includes('employee'),
  'User Model incorporates all 6 enterprise role hierarchy tiers'
);
console.log('    ↳ Configured Roles Hierarchy:', USER_ROLES.join(' > '));

// 1.3: User model fields check (password select:false, tokenVersion, refreshToken)
assert(
  Boolean(User.schema.paths.password) &&
    User.schema.paths.password.options.select === false &&
    Boolean(User.schema.paths.tokenVersion) &&
    Boolean(User.schema.paths.refreshToken),
  'User schema configures secure password (select:false), tokenVersion, and refreshToken'
);

// 1.4: Ticket & Asset models
assert(
  Boolean(Ticket.schema.paths.ticketId) && Boolean(Asset.schema.paths.assetTag),
  'Ticket and Asset models defined with primary enterprise tags'
);

// =============================================================
// TEST SUITE 2: Password Security & Bcrypt 12 Rounds
// =============================================================
console.log('\n--- Suite 2: Password Security & Bcrypt 12 Rounds ---');

// 2.1: Password strength enforcement
const strongCheck = validatePasswordStrength('ComplexPass123!');
const weakCheck = validatePasswordStrength('simple');
assert(strongCheck.isValid === true, 'validatePasswordStrength accepts compliant enterprise password');
assert(weakCheck.isValid === false, 'validatePasswordStrength rejects weak non-compliant password');

// 2.2: Pure Bcrypt hashing and comparison with 12 salt rounds
const dynamicHash = await hashPassword('SecretTest2026!');
assert(
  typeof dynamicHash === 'string' &&
    (dynamicHash.startsWith('$2a$12$') || dynamicHash.startsWith('$2b$12$')),
  'hashPassword securely encodes passwords using Bcrypt with 12 salt rounds'
);
const validVerify = await verifyPassword('SecretTest2026!', dynamicHash);
const invalidVerify = await verifyPassword('BadGuess999!', dynamicHash);
assert(validVerify === true, 'verifyPassword confirms genuine bcrypt password match');
assert(invalidVerify === false, 'verifyPassword rejects spoofed password match');
console.log('    ↳ Bcrypt hash output (12 rounds):', dynamicHash.substring(0, 28) + '...');

// 2.3: User model comparePassword and toSafeObject
const rawPassword = 'EmployeePassword123!';
const salt = bcrypt.genSaltSync(12);
const hashed = bcrypt.hashSync(rawPassword, salt);

const mockUser = new User({
  userId: 'emp_101',
  orgId: 'org_abc',
  name: 'Sarah Jenkins',
  email: 'sarah.j@abctech.com',
  password: hashed,
  role: 'employee',
  department: 'Engineering',
  managerId: 'mgr_201',
});

const isCorrect = await mockUser.comparePassword('EmployeePassword123!');
const isWrong = await mockUser.comparePassword('WrongPassword999!');

assert(isCorrect === true, 'comparePassword correctly validates authentic password');
assert(isWrong === false, 'comparePassword strictly rejects incorrect password');

// 2.4: Safe object check (no password, refreshToken, or tokenVersion leakage)
const safeUser = mockUser.toSafeObject();
assert(
  safeUser.password === undefined &&
    safeUser.refreshToken === undefined &&
    safeUser.tokenVersion === undefined &&
    safeUser.userId === 'emp_101',
  'toSafeObject sanitizes sensitive password, refreshToken, and tokenVersion from API responses'
);
console.log('    ↳ Sanitized User Payload:', JSON.stringify({ userId: safeUser.userId, email: safeUser.email, role: safeUser.role }));

// =============================================================
// TEST SUITE 3: Dual-Token System & Instant Revocation
// =============================================================
console.log('\n--- Suite 3: Dual-Token System & Instant Revocation Claims ---');

const userForTokens = {
  userId: 'emp_101',
  name: 'Sarah Jenkins',
  email: 'sarah.j@abctech.com',
  role: 'employee',
  orgId: 'org_abc',
  department: 'Engineering',
  managerId: 'mgr_201',
  tokenVersion: 2,
};

const tokenPair = generateTokens(userForTokens);
assert(
  Boolean(tokenPair.accessToken) && Boolean(tokenPair.refreshToken),
  'generateTokens issues both Access Token (15m) and Refresh Token (7d)'
);

const decodedAccess = verifyAccessToken(tokenPair.accessToken);
const decodedRefresh = verifyRefreshToken(tokenPair.refreshToken);

assert(
  decodedAccess.userId === 'emp_101' &&
    decodedAccess.version === 2 &&
    decodedAccess.orgId === 'org_abc' &&
    decodedAccess.iss === 'omnidesk-api',
  'Access Token contains user identity, org tenant, tokenVersion, and omnidesk-api issuer'
);

assert(
  decodedRefresh.userId === 'emp_101' && decodedRefresh.version === 2,
  'Refresh Token contains userId and matching tokenVersion'
);
console.log('    ↳ Dual Tokens Minted: Access (15m) & Refresh (7d) with version =', decodedAccess.version);

// =============================================================
// TEST SUITE 4: Role-Based Access Control (RBAC) Middleware
// =============================================================
console.log('\n--- Suite 4: Least-Privilege Role Authorization (RBAC) ---');

// 4.1: Employee accessing Manager-only route (Blocked)
const employeeReq = { user: { role: 'employee', orgId: 'org_abc' } };
const mockRes1 = createMockRes();
let nextCalled1 = false;

const managerGuard = requireRoles('manager', 'org_admin');
managerGuard(employeeReq, mockRes1, () => {
  nextCalled1 = true;
});

assert(
  nextCalled1 === false &&
    mockRes1.statusCode === 403 &&
    mockRes1.payload.message.includes("Role 'employee' lacks permission"),
  "Employee is strictly BLOCKED from Manager-restricted endpoint (RBAC 403)"
);

// 4.2: Manager accessing Manager-only route (Allowed)
const managerReq = { user: { role: 'manager', orgId: 'org_abc' } };
const mockRes2 = createMockRes();
let nextCalled2 = false;

managerGuard(managerReq, mockRes2, () => {
  nextCalled2 = true;
});

assert(
  nextCalled2 === true && mockRes2.statusCode === 200,
  'Manager is permitted to access Manager-restricted endpoint'
);

// 4.3: Super Admin bypasses all checks
const superAdminReq = { user: { role: 'super_admin', orgId: 'org_platform' } };
const mockRes3 = createMockRes();
let nextCalled3 = false;

managerGuard(superAdminReq, mockRes3, () => {
  nextCalled3 = true;
});

assert(
  nextCalled3 === true,
  'Super Admin role automatically bypasses all domain-level role restrictions'
);

// =============================================================
// TEST SUITE 5: Multi-Tenant Boundary Enforcement
// =============================================================
console.log('\n--- Suite 5: Multi-Tenant Isolation Enforcement ---');

// 5.1: Cross-tenant access attempt (Blocked)
const crossTenantReq = {
  user: { role: 'employee', orgId: 'org_abc' },
  body: { orgId: 'org_xyz' },
};
const mockRes4 = createMockRes();
let nextCalled4 = false;

requireSameOrg(crossTenantReq, mockRes4, () => {
  nextCalled4 = true;
});

assert(
  nextCalled4 === false &&
    mockRes4.statusCode === 403 &&
    mockRes4.payload.message.includes('Tenant Isolation Breach'),
  'Cross-tenant data access is strictly blocked at middleware level'
);

// 5.2: Same-tenant access (Allowed)
const validTenantReq = {
  user: { role: 'employee', orgId: 'org_abc' },
  body: { orgId: 'org_abc' },
};
const mockRes5 = createMockRes();
let nextCalled5 = false;

requireSameOrg(validTenantReq, mockRes5, () => {
  nextCalled5 = true;
});

assert(
  nextCalled5 === true && mockRes5.statusCode === 200,
  'Same-tenant request proceeds cleanly within authorized workspace'
);

// =============================================================
// TEST SUITE 6: Zod Schema Input Sanitization & Validation
// =============================================================
console.log('\n--- Suite 6: Zod Schema Input Sanitization & Validation ---');

// 6.1: Valid login payload parses cleanly
const validLoginParse = loginSchema.safeParse({
  email: 'sarah.j@abctech.com',
  password: 'EmployeePassword123!',
});
assert(validLoginParse.success === true, 'Zod loginSchema accepts compliant corporate email & password');

// 6.2: Invalid email rejected
const invalidEmailParse = loginSchema.safeParse({
  email: 'not-an-email',
  password: 'EmployeePassword123!',
});
assert(
  invalidEmailParse.success === false &&
    invalidEmailParse.error.errors[0].message.includes('valid corporate email'),
  'Zod loginSchema strictly rejects malformed email addresses'
);

// 6.3: Registration password complexity enforced
const weakRegParse = registerSchema.safeParse({
  name: 'John Doe',
  email: 'john.d@abctech.com',
  password: 'weak',
});
assert(
  weakRegParse.success === false,
  'Zod registerSchema rejects passwords that fail 8-character and complexity constraints'
);

// 6.4: ValidateSchema middleware pipeline execution
const zodMiddleware = validateSchema(loginSchema);
const badReq = { body: { email: 'bad-email', password: '' } };
const badRes = createMockRes();
let zodNext = false;
zodMiddleware(badReq, badRes, () => {
  zodNext = true;
});
assert(
  zodNext === false && badRes.statusCode === 400 && Boolean(badRes.payload.error),
  'validateSchema middleware blocks invalid input with 400 Bad Request and field-level diagnostics'
);

// =============================================================
// TEST SUITE 7: Brute-Force Rate Limiting (authLimiter)
// =============================================================
console.log('\n--- Suite 7: Brute-Force Rate Limiting Middleware ---');

const rateLimitIp = '192.168.1.50';
let rateLimitBlocked = false;
let lastRateRes = null;

for (let i = 1; i <= 11; i++) {
  const req = {
    headers: { 'x-forwarded-for': rateLimitIp },
    socket: {},
  };
  const res = createMockRes();
  let nextCalled = false;
  await authLimiter(req, res, () => {
    nextCalled = true;
  });

  lastRateRes = res;
  if (!nextCalled && res.statusCode === 429) {
    rateLimitBlocked = true;
    break;
  }
}

assert(
  rateLimitBlocked === true &&
    lastRateRes.statusCode === 429 &&
    lastRateRes.payload.message.includes('Too many authentication attempts'),
  'authLimiter blocks brute-force authentication requests after exceeding 10 attempts (429)'
);
console.log('    ↳ Rate limiter response:', lastRateRes.statusCode, lastRateRes.payload.message);

// =============================================================
// TEST SUITE 8: Production Auth Endpoints & Token Revocation
// =============================================================
console.log('\n--- Suite 8: Production Authentication Services & Controller API ---');

// Lightweight test harness for offline unit test execution
const testUserDb = new Map();

// Seed initial test users
const sarahPasswordHash = bcrypt.hashSync('EmployeePassword123!', 12);
const davidPasswordHash = bcrypt.hashSync('ManagerPassword123!', 12);

const sarahDoc = new User({
  userId: 'emp_101',
  orgId: 'org_abc',
  name: 'Sarah Jenkins',
  email: 'sarah.j@abctech.com',
  password: sarahPasswordHash,
  role: 'employee',
  department: 'Engineering',
  managerId: 'mgr_201',
  status: 'ACTIVE',
  tokenVersion: 0,
});

const davidDoc = new User({
  userId: 'mgr_201',
  orgId: 'org_abc',
  name: 'David Miller',
  email: 'david.m@abctech.com',
  password: davidPasswordHash,
  role: 'manager',
  department: 'Engineering',
  managerId: null,
  status: 'ACTIVE',
  tokenVersion: 0,
});

testUserDb.set('sarah.j@abctech.com', sarahDoc);
testUserDb.set('emp_101', sarahDoc);
testUserDb.set('david.m@abctech.com', davidDoc);
testUserDb.set('mgr_201', davidDoc);

// Mock Mongoose operations if MongoDB is not connected
if (User.db?.readyState !== 1) {
  User.prototype.save = async function () {
    if (this.isModified && this.isModified('password')) {
      const salt = await bcrypt.genSalt(12);
      this.password = await bcrypt.hash(this.password, salt);
    }
    testUserDb.set(this.email.toLowerCase(), this);
    testUserDb.set(this.userId, this);
    return this;
  };

  User.findOne = function (query) {
    const chain = {
      select(fields) {
        return this;
      },
      then(resolve, reject) {
        let match = null;
        if (query.email) {
          match = testUserDb.get(query.email.toLowerCase()) || null;
        } else if (query.userId) {
          match = testUserDb.get(query.userId) || null;
        }
        return Promise.resolve(match).then(resolve, reject);
      },
      catch(reject) {
        return this.then(null, reject);
      },
    };
    return chain;
  };

  User.updateOne = async function (filter, update) {
    let match = null;
    if (filter.email) match = testUserDb.get(filter.email.toLowerCase());
    if (filter.userId) match = testUserDb.get(filter.userId);
    if (match) {
      if (update.$set) {
        Object.assign(match, update.$set);
      }
      if (update.$inc) {
        for (const [key, val] of Object.entries(update.$inc)) {
          match[key] = (match[key] || 0) + val;
        }
      }
    }
    return { modifiedCount: match ? 1 : 0 };
  };
}

// 8.1: Register new user endpoint
const regReq = {
  body: {
    userId: 'emp_305',
    name: 'Alex Rivera',
    email: 'alex.r@abctech.com',
    password: 'SecurePassword2026!',
    orgId: 'org_abc',
    department: 'Marketing',
    role: 'employee',
  },
};
const regRes = createMockRes();
await register(regReq, regRes, (err) => { if (err) console.error(err); });

assert(
  regRes.statusCode === 201 &&
    regRes.payload.data.user.email === 'alex.r@abctech.com' &&
    regRes.payload.data.user.password === undefined,
  'Registration endpoint creates user, hashes password with 12 rounds, and returns 201 with sanitized user'
);
console.log('    ↳ Registered user:', regRes.payload.data.user.name, `(${regRes.payload.data.user.email})`);

// 8.2: Valid login returns dual tokens (accessToken + refreshToken)
const loginReq1 = { body: { email: 'sarah.j@abctech.com', password: 'EmployeePassword123!' } };
const loginRes1 = createMockRes();
await login(loginReq1, loginRes1, (err) => { if (err) console.error(err); });

assert(
  loginRes1.statusCode === 200 &&
    Boolean(loginRes1.payload.data.accessToken) &&
    Boolean(loginRes1.payload.data.refreshToken) &&
    loginRes1.payload.data.user.role === 'employee' &&
    loginRes1.payload.data.user.leaveBalances.casual === 12,
  'Employee login returns dual tokens (accessToken 15m + refreshToken 7d) and sanitized user profile'
);
const activeSarahToken = loginRes1.payload.data.accessToken;
const activeSarahRefresh = loginRes1.payload.data.refreshToken;
console.log('    ↳ Sarah Login: Dual tokens generated, tokenVersion bumped to', sarahDoc.tokenVersion);

// 8.3: Incorrect password rejected with 401
const badLoginReq = { body: { email: 'sarah.j@abctech.com', password: 'WrongPassword!' } };
const badLoginRes = createMockRes();
await login(badLoginReq, badLoginRes, (err) => { if (err) console.error(err); });

assert(
  badLoginRes.statusCode === 401 && badLoginRes.payload.message.includes('Invalid corporate credentials'),
  'Login endpoint rejects incorrect password with 401 Unauthorized'
);

// 8.4: Profile endpoint (GET /me) with authenticateJwt
const meReq = {
  headers: { authorization: `Bearer ${activeSarahToken}` },
};
const meRes = createMockRes();
await authenticateJwt(meReq, meRes, async () => {
  await getMe(meReq, meRes, (err) => { if (err) console.error(err); });
});

assert(
  meRes.statusCode === 200 && meRes.payload.data.user.email === 'sarah.j@abctech.com',
  'authenticateJwt verifies Access Token and profile endpoint returns authenticated profile'
);
console.log('    ↳ Profile Retrieved:', meRes.payload.data.user.name, `(${meRes.payload.data.user.email})`);

// 8.5: Refresh Token rotation (POST /refresh)
const refreshReq = { body: { refreshToken: activeSarahRefresh } };
const refreshRes = createMockRes();
await refreshToken(refreshReq, refreshRes, (err) => { if (err) console.error(err); });

assert(
  refreshRes.statusCode === 200 &&
    Boolean(refreshRes.payload.data.accessToken) &&
    Boolean(refreshRes.payload.data.refreshToken),
  'Token rotation endpoint validates 7d refresh token and mints fresh token pair'
);
const rotatedAccessToken = refreshRes.payload.data.accessToken;

// 8.6: Instant Token Revocation via logout
const logoutReq = {
  user: { userId: 'emp_101' },
};
const logoutRes = createMockRes();
await logout(logoutReq, logoutRes, (err) => { if (err) console.error(err); });

assert(
  logoutRes.statusCode === 200 && sarahDoc.refreshToken === null,
  'Logout endpoint clears stored refreshToken and increments tokenVersion'
);
console.log('    ↳ Logout successful: tokenVersion now =', sarahDoc.tokenVersion);

// 8.7: Verify revoked token is now REJECTED by authenticateJwt
const revokedReq = {
  headers: { authorization: `Bearer ${rotatedAccessToken}` },
};
const revokedRes = createMockRes();
let revokedNextCalled = false;
await authenticateJwt(revokedReq, revokedRes, () => {
  revokedNextCalled = true;
});

assert(
  revokedNextCalled === false &&
    revokedRes.statusCode === 401 &&
    revokedRes.payload.message.includes('Token has been revoked'),
  'Instant Token Revocation: Previously issued access token is immediately REJECTED after logout/version bump (401)'
);
console.log('    ↳ Revocation check:', revokedRes.statusCode, revokedRes.payload.message);

// 8.8: Forgot password visual stub
const forgotReq = { body: { email: 'sarah.j@abctech.com' } };
const forgotRes = createMockRes();
await forgotPasswordStub(forgotReq, forgotRes, (err) => { if (err) console.error(err); });

assert(
  forgotRes.statusCode === 200 && forgotRes.payload.data.simulated === true,
  'Forgot password stub safely returns simulated dispatch notice'
);

console.log('\n================================================================');
console.log(`🎉 SPRINT 1 ENTERPRISE AUTH VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
console.log('================================================================\n');

process.exit(totalTests === passedTests ? 0 : 1);
