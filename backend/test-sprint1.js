import { Organization } from './src/models/Organization.model.js';
import { User, USER_ROLES } from './src/models/User.model.js';
import { Ticket } from './src/models/Ticket.model.js';
import { Asset } from './src/models/Asset.model.js';
import { generateToken, verifyToken } from './src/utils/jwt.js';
import { requireRoles, requireSameOrg } from './src/middlewares/auth.middleware.js';
import bcrypt from 'bcryptjs';

console.log('================================================================');
console.log('🛡️  OMNIDESK AI — SPRINT 1 ACCEPTANCE & ARCHITECTURE VERIFICATION');
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

// =============================================================
// TEST SUITE 1: Multi-Tenant & Role Hierarchy Schemas
// =============================================================
console.log('--- Suite 1: Multi-Tenant Data Schemas & Role Hierarchy ---');

// 1.1: Organization Model schema
const orgIndexes = Organization.schema.indexes();
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

// 1.3: User model has managerId pointer
assert(
  Boolean(User.schema.paths.managerId),
  'User schema includes managerId pointer for team hierarchy mapping'
);

// 1.4: Ticket & Asset models
assert(
  Boolean(Ticket.schema.paths.ticketId) && Boolean(Asset.schema.paths.assetTag),
  'Ticket and Asset models defined with primary enterprise tags'
);

// =============================================================
// TEST SUITE 2: Password Security & Bcrypt Hashing
// =============================================================
console.log('\n--- Suite 2: Password Security & Bcrypt Validation ---');

const rawPassword = 'EmployeePassword123!';
const salt = bcrypt.genSaltSync(10);
const hashed = bcrypt.hashSync(rawPassword, salt);

const mockUser = new User({
  userId: 'emp_101',
  orgId: 'org_abc',
  name: 'Sarah Jenkins',
  email: 'sarah.j@abctech.com',
  passwordHash: hashed,
  role: 'employee',
  department: 'Engineering',
  managerId: 'mgr_201',
});

const correctMatch = mockUser.comparePassword('EmployeePassword123!');
const wrongMatch = mockUser.comparePassword('WrongPassword999!');

assert(correctMatch instanceof Promise, 'comparePassword returns asynchronous bcrypt promise');

const isCorrect = await correctMatch;
const isWrong = await wrongMatch;

assert(isCorrect === true, 'comparePassword correctly validates authentic password');
console.log(`    ↳ Valid password check   : ${isCorrect} (Matches hashed bcrypt salt)`);

assert(isWrong === false, 'comparePassword strictly rejects incorrect password');
console.log(`    ↳ Invalid password check : ${isWrong} (Blocked securely)`);

// Safe object check (no password leakage)
const safeUser = mockUser.toSafeObject();
assert(
  safeUser.passwordHash === undefined && safeUser.userId === 'emp_101',
  'toSafeObject sanitizes sensitive passwordHash from API responses'
);
console.log('    ↳ Sanitized User Payload :', JSON.stringify({ userId: safeUser.userId, email: safeUser.email, role: safeUser.role, managerId: safeUser.managerId }));

// =============================================================
// TEST SUITE 3: Signed JWT Tokens & Claims Validation
// =============================================================
console.log('\n--- Suite 3: Enterprise JWT Authentication & Token Claims ---');

const tokenPayload = {
  userId: 'emp_101',
  name: 'Sarah Jenkins',
  email: 'sarah.j@abctech.com',
  role: 'employee',
  orgId: 'org_abc',
  department: 'Engineering',
  managerId: 'mgr_201',
};

const token = generateToken(tokenPayload, '1h');
assert(typeof token === 'string' && token.split('.').length === 3, 'Generates valid 3-part signed JWT string');
console.log(`    ↳ Generated Token: ${token.substring(0, 36)}...`);

const decoded = verifyToken(token);
assert(
  decoded.userId === 'emp_101' &&
    decoded.role === 'employee' &&
    decoded.orgId === 'org_abc' &&
    decoded.managerId === 'mgr_201' &&
    decoded.iss === 'omnidesk-api',
  'JWT token decodes verified identity, tenant orgId, role, and issuer'
);
console.log('    ↳ Decoded Claims :', JSON.stringify({
  userId: decoded.userId,
  role: decoded.role,
  orgId: decoded.orgId,
  managerId: decoded.managerId,
  issuer: decoded.iss,
}));

// =============================================================
// TEST SUITE 4: Role-Based Access Control (RBAC) Middleware
// =============================================================
console.log('\n--- Suite 4: Least-Privilege Role Authorization (RBAC) ---');

// Mock Express response generator
function createMockRes() {
  const res = {
    statusCode: 200,
    payload: null,
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
console.log(`    ↳ Access result: role='employee' on manager endpoint -> Status ${mockRes1.statusCode} (${mockRes1.payload.message})`);

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
console.log('    ↳ Access result: role=\'manager\' on manager endpoint -> Allowed (next() called)');

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
console.log('    ↳ Access result: role=\'super_admin\' -> Super-bypass allowed');

// =============================================================
// TEST SUITE 5: Multi-Tenant Boundary Enforcement
// =============================================================
console.log('\n--- Suite 5: Multi-Tenant Isolation Enforcement ---');

// 5.1: Cross-tenant access attempt (Blocked)
const crossTenantReq = {
  user: { role: 'employee', orgId: 'org_abc' },
  body: { orgId: 'org_xyz' }, // Attempting to alter data in org_xyz
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
console.log(`    ↳ Isolation result: userOrg='org_abc', targetOrg='org_xyz' -> Status ${mockRes4.statusCode} (${mockRes4.payload.message})`);

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
console.log('    ↳ Isolation result: userOrg=\'org_abc\', targetOrg=\'org_abc\' -> Allowed');

// =============================================================
// TEST SUITE 6: End-to-End Authentication Controller API
// =============================================================
console.log('\n--- Suite 6: Authentication Endpoints (Login, Profile, Recovery) ---');

import { login, getMe, forgotPasswordStub } from './src/controllers/auth.controller.js';

// 6.1: Valid login as Sarah Jenkins (Employee)
const loginReq1 = { body: { email: 'sarah.j@abctech.com', password: 'EmployeePassword123!' } };
const loginRes1 = createMockRes();
await login(loginReq1, loginRes1, (err) => { if (err) console.error(err); });

assert(
  loginRes1.statusCode === 200 &&
    Boolean(loginRes1.payload.data.token) &&
    loginRes1.payload.data.user.role === 'employee' &&
    loginRes1.payload.data.user.leaveBalances.casual === 12,
  'Employee login returns valid JWT token and profile with correct leave balances'
);
console.log('    ↳ Sarah Login Response: Token generated, role =', loginRes1.payload.data.user.role, ', Casual leaves =', loginRes1.payload.data.user.leaveBalances.casual);

// 6.2: Valid login as David Miller (Manager)
const loginReq2 = { body: { email: 'david.m@abctech.com', password: 'ManagerPassword123!' } };
const loginRes2 = createMockRes();
await login(loginReq2, loginRes2, (err) => { if (err) console.error(err); });

assert(
  loginRes2.statusCode === 200 &&
    loginRes2.payload.data.user.role === 'manager' &&
    loginRes2.payload.data.user.userId === 'mgr_201',
  'Manager login returns valid JWT token with managerial privileges'
);
console.log('    ↳ David Login Response: Token generated, role =', loginRes2.payload.data.user.role, ', userId =', loginRes2.payload.data.user.userId);

// 6.3: Incorrect password rejected
const badLoginReq = { body: { email: 'sarah.j@abctech.com', password: 'WrongPassword!' } };
const badLoginRes = createMockRes();
await login(badLoginReq, badLoginRes, (err) => { if (err) console.error(err); });

assert(
  badLoginRes.statusCode === 401 && badLoginRes.payload.message.includes('Incorrect password'),
  'Login endpoint rejects incorrect password with 401 Unauthorized'
);
console.log('    ↳ Bad Password Result:', badLoginRes.statusCode, badLoginRes.payload.message);

// 6.4: Profile endpoint (GET /me)
const meReq = { user: { userId: 'emp_101', role: 'employee', orgId: 'org_abc' } };
const meRes = createMockRes();
await getMe(meReq, meRes, (err) => { if (err) console.error(err); });

assert(
  meRes.statusCode === 200 && meRes.payload.data.user.email === 'sarah.j@abctech.com',
  'Profile endpoint (/api/auth/me) returns authenticated user details'
);
console.log('    ↳ Profile Retrieved:', meRes.payload.data.user.name, `(${meRes.payload.data.user.email})`);

// 6.5: Forgot password visual stub
const forgotReq = { body: { email: 'sarah.j@abctech.com' } };
const forgotRes = createMockRes();
await forgotPasswordStub(forgotReq, forgotRes, (err) => { if (err) console.error(err); });

assert(
  forgotRes.statusCode === 200 && forgotRes.payload.data.simulated === true,
  'Forgot password stub safely returns simulated dispatch notice'
);
console.log('    ↳ Forgot Password Stub:', forgotRes.payload.message);

console.log('\n================================================================');
console.log(`🎉 SPRINT 1 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
console.log('================================================================\n');
