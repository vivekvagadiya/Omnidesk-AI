import assert from 'node:assert';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { connectRedis, disconnectRedis, getRedisClient } from '../src/config/redis.js';
import { User } from '../src/models/User.model.js';
import { Ticket } from '../src/models/Ticket.model.js';
import { Asset } from '../src/models/Asset.model.js';
import { Notification } from '../src/models/Notification.model.js';
import { getLeaveBalance } from '../src/controllers/profile.controller.js';
import { getTickets } from '../src/controllers/ticket.controller.js';
import { getAssets, getAssetByTag, updateAsset } from '../src/controllers/asset.controller.js';
import { uploadDocument, approveAction, rejectAction } from '../src/controllers/copilot.controller.js';
import {
  getLeaveBalance as toolGetLeaveBalance,
  createTicket as toolCreateTicket,
  applyLeave as toolApplyLeave,
  requestHardwareUpgrade as toolRequestHardware,
  ToolExecutionError,
} from '../src/services/tools/toolRegistry.service.js';
import {
  stageActionToken,
  consumeActionToken,
  ACTION_TYPES,
  UnauthorizedActionError,
} from '../src/services/tools/hitlGatekeeper.service.js';
import { requireRoles } from '../src/middlewares/auth.middleware.js';

let passedTests = 0;
let totalTests = 0;

async function runTestAsync(description, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ [PASS] ${description}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${description}`);
    console.error(`     Reason: ${err.message}`);
    throw err;
  }
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
    setHeader(key, val) {
      this.headers[key.toLowerCase()] = val;
      return this;
    },
  };
  return res;
}

function createMockReq({ user, query = {}, params = {}, body = {}, file = null }) {
  return {
    user,
    query,
    params,
    body,
    file,
    headers: {},
    app: { locals: {} },
  };
}

// -------------------------------------------------------------
// Test Runner
// -------------------------------------------------------------
async function runRoleVerification() {
  console.log('\n================================================================');
  console.log('🛡️  OMNIDESK SPRINT 6: END-TO-END ROLE & ACCESS CONTROL VERIFICATION');
  console.log('================================================================\n');

  await connectDB();
  let redis = null;
  try {
    redis = await Promise.race([
      connectRedis(),
      new Promise((res) => setTimeout(() => res(null), 1000)),
    ]);
  } catch {
    redis = null;
  }

  const orgId = 'org_abc';
  const foreignOrgId = 'org_foreign_xyz';

  // Test User Personas
  const sarah = {
    userId: 'emp_101',
    name: 'Sarah Jenkins',
    email: 'sarah@yopmail.com',
    role: 'employee',
    department: 'Engineering',
    managerId: 'mgr_201',
    orgId,
    leaveBalances: { casual: 12, sick: 7, maternity: 90 },
  };

  const james = {
    userId: 'emp_102',
    name: 'James Carter',
    email: 'james@yopmail.com',
    role: 'employee',
    department: 'Engineering',
    managerId: 'mgr_201',
    orgId,
    leaveBalances: { casual: 12, sick: 7, maternity: 90 },
  };

  const priya = {
    userId: 'emp_103',
    name: 'Priya Sharma',
    email: 'priya@yopmail.com',
    role: 'employee',
    department: 'Human Resources',
    managerId: 'usr_hr_admin', // Reports to HR Admin, NOT to David
    orgId,
    leaveBalances: { casual: 12, sick: 7, maternity: 90 },
  };

  const david = {
    userId: 'mgr_201',
    name: 'David Miller',
    email: 'david@yopmail.com',
    role: 'manager',
    department: 'Engineering',
    managerId: 'usr_org_admin',
    orgId,
    leaveBalances: { casual: 15, sick: 8, maternity: 90 },
  };

  const marcus = {
    userId: 'usr_it_admin',
    name: 'Marcus Vance',
    email: 'marcus@yopmail.com',
    role: 'it_admin',
    department: 'IT Infrastructure',
    managerId: null,
    orgId,
    leaveBalances: { casual: 18, sick: 8, maternity: 90 },
  };

  const alex = {
    userId: 'usr_hr_admin',
    name: 'Alex Morgan',
    email: 'alex@yopmail.com',
    role: 'hr_admin',
    department: 'Human Resources',
    managerId: 'usr_org_admin',
    orgId,
    leaveBalances: { casual: 18, sick: 8, maternity: 90 },
  };

  const elena = {
    userId: 'usr_org_admin',
    name: 'Elena Rostova',
    email: 'elena@yopmail.com',
    role: 'org_admin',
    department: 'Executive',
    managerId: null,
    orgId,
    leaveBalances: { casual: 20, sick: 10, maternity: 90 },
  };

  const foreignUser = {
    userId: 'usr_foreign_99',
    name: 'Foreign Intruder',
    email: 'intruder@foreigncorp.com',
    role: 'employee',
    department: 'General',
    managerId: null,
    orgId: foreignOrgId,
    leaveBalances: { casual: 5, sick: 5, maternity: 0 },
  };

  // In-Memory DB Stores for standalone sandbox execution
  const memUserDb = new Map();
  const memTicketDb = new Map();
  const memAssetDb = new Map();

  const allUsers = [sarah, james, priya, david, marcus, alex, elena, foreignUser];
  for (const u of allUsers) {
    memUserDb.set(u.userId, { ...u, leaveBalances: { ...u.leaveBalances } });
  }

  const assetSarahMac = {
    assetTag: 'HW-MAC-042',
    orgId,
    type: 'LAPTOP',
    model: 'MacBook Pro 16" M3 Max',
    assignedTo: sarah.userId,
    status: 'ASSIGNED',
    cost: 3499,
  };
  const assetStockMon = {
    assetTag: 'HW-MON-108',
    orgId,
    type: 'MONITOR',
    model: 'Dell UltraSharp 32" 4K Monitor',
    assignedTo: null,
    status: 'IN_STOCK',
    cost: 799,
  };
  memAssetDb.set(assetSarahMac.assetTag, { ...assetSarahMac });
  memAssetDb.set(assetStockMon.assetTag, { ...assetStockMon });

  const ticketSarah = {
    ticketId: 'TICK-SARAH-01',
    orgId,
    userId: sarah.userId,
    title: 'VPN disconnects on home network',
    description: 'VPN client drops every 15 minutes.',
    category: 'IT_ACCESS',
    priority: 'MEDIUM',
    status: 'OPEN',
    createdAt: new Date().toISOString(),
  };
  const ticketPriya = {
    ticketId: 'TICK-PRIYA-01',
    orgId,
    userId: priya.userId,
    title: 'HR portal onboarding checklist bug',
    description: 'New hire documents not rendering in HR portal.',
    category: 'HR_BENEFITS',
    priority: 'HIGH',
    status: 'OPEN',
    createdAt: new Date().toISOString(),
  };
  memTicketDb.set(ticketSarah.ticketId, { ...ticketSarah });
  memTicketDb.set(ticketPriya.ticketId, { ...ticketPriya });

  // Install mocks if MongoDB is not connected in sandbox
  if (User.db?.readyState !== 1) {
    User.findOne = function (query) {
      const chain = {
        select() { return this; },
        sort() { return this; },
        skip() { return this; },
        limit() { return this; },
        lean() { return this; },
        then(resolve, reject) {
          let match = null;
          if (query.userId) {
            const u = memUserDb.get(query.userId);
            if (u && (!query.orgId || u.orgId === query.orgId) && (!query.managerId || u.managerId === query.managerId)) {
              match = u;
            }
          }
          return Promise.resolve(match).then(resolve, reject);
        },
        catch(reject) { return this.then(null, reject); },
      };
      return chain;
    };

    User.find = function (query) {
      const chain = {
        select() { return this; },
        sort() { return this; },
        skip() { return this; },
        limit() { return this; },
        lean() { return this; },
        then(resolve, reject) {
          const results = [];
          for (const u of memUserDb.values()) {
            if (query.orgId && u.orgId !== query.orgId) continue;
            if (query.managerId && u.managerId !== query.managerId) continue;
            results.push(u);
          }
          return Promise.resolve(results).then(resolve, reject);
        },
        catch(reject) { return this.then(null, reject); },
      };
      return chain;
    };

    Notification.insertMany = async function (docs) {
      return docs || [];
    };

    Notification.find = function () {
      return {
        sort() { return this; },
        skip() { return this; },
        limit() { return this; },
        lean() { return this; },
        then(res) { return Promise.resolve([]).then(res); },
        catch(rej) { return Promise.resolve([]).catch(rej); },
      };
    };

    User.findOneAndUpdate = async function (filter, update) {
      let match = null;
      if (filter.userId) match = memUserDb.get(filter.userId);
      if (!match) return null;

      if (update.$inc) {
        for (const [key, delta] of Object.entries(update.$inc)) {
          if (key.startsWith('leaveBalances.')) {
            const leaveType = key.split('.')[1];
            if (match.leaveBalances) {
              match.leaveBalances[leaveType] = (match.leaveBalances[leaveType] || 0) + delta;
            }
          }
        }
      }
      return match;
    };

    Ticket.find = function (query) {
      const chain = {
        select() { return this; },
        sort() { return this; },
        skip() { return this; },
        limit() { return this; },
        lean() { return this; },
        then(resolve, reject) {
          const results = [];
          for (const t of memTicketDb.values()) {
            if (query.orgId && t.orgId !== query.orgId) continue;
            if (query.userId) {
              if (typeof query.userId === 'string' && t.userId !== query.userId) continue;
              if (query.userId.$in && !query.userId.$in.includes(t.userId)) continue;
            }
            results.push(t);
          }
          return Promise.resolve(results).then(resolve, reject);
        },
        catch(reject) { return this.then(null, reject); },
      };
      return chain;
    };

    Ticket.countDocuments = async function (query) {
      let count = 0;
      for (const t of memTicketDb.values()) {
        if (query.orgId && t.orgId !== query.orgId) continue;
        if (query.userId) {
          if (typeof query.userId === 'string' && t.userId !== query.userId) continue;
          if (query.userId.$in && !query.userId.$in.includes(t.userId)) continue;
        }
        count++;
      }
      return count;
    };

    Ticket.create = async function (data) {
      const doc = {
        ...data,
        _id: 'mock_ticket_' + Date.now(),
        createdAt: new Date().toISOString(),
      };
      memTicketDb.set(doc.ticketId, doc);
      return doc;
    };

    Asset.find = function (query) {
      const chain = {
        select() { return this; },
        sort() { return this; },
        skip() { return this; },
        limit() { return this; },
        lean() { return this; },
        then(resolve, reject) {
          const results = [];
          for (const a of memAssetDb.values()) {
            if (query.orgId && a.orgId !== query.orgId) continue;
            if (query.assignedTo && a.assignedTo !== query.assignedTo) continue;
            if (query.status && a.status !== query.status) continue;
            if (query.type && a.type !== query.type) continue;
            if (query.$or) {
              const matchedOr = query.$or.some((clause) => {
                if (clause.assignedTo?.$in && clause.assignedTo.$in.includes(a.assignedTo)) return true;
                if (clause.status && clause.status === a.status) return true;
                return false;
              });
              if (!matchedOr) continue;
            }
            results.push(a);
          }
          return Promise.resolve(results).then(resolve, reject);
        },
        catch(reject) { return this.then(null, reject); },
      };
      return chain;
    };

    Asset.countDocuments = async function (query) {
      let count = 0;
      for (const a of memAssetDb.values()) {
        if (query.orgId && a.orgId !== query.orgId) continue;
        if (query.assignedTo && a.assignedTo !== query.assignedTo) continue;
        if (query.status && a.status !== query.status) continue;
        if (query.type && a.type !== query.type) continue;
        count++;
      }
      return count;
    };

    Asset.findOne = function (query) {
      const chain = {
        select() { return this; },
        lean() { return this; },
        then(resolve, reject) {
          let match = null;
          if (query.assetTag) match = memAssetDb.get(query.assetTag);
          return Promise.resolve(match).then(resolve, reject);
        },
        catch(reject) { return this.then(null, reject); },
      };
      return chain;
    };

    Asset.findOneAndUpdate = async function (filter, update) {
      let match = null;
      if (filter.assetTag) match = memAssetDb.get(filter.assetTag);
      if (!match) return null;

      if (update.$set) {
        Object.assign(match, update.$set);
      }
      return match;
    };
  }

  try {
    // =========================================================================
    // SUITE 1: Employee (Sarah Jenkins) Verification
    // =========================================================================
    console.log('\n--- 1. Employee (Sarah Jenkins) Verification ---');

    await runTestAsync('1.1 Sarah can check her own leave balance (GET /api/profile/balance)', async () => {
      const req = createMockReq({ user: sarah });
      const res = createMockRes();
      await getLeaveBalance(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.success, true);
      assert.strictEqual(res.payload.data.userId, sarah.userId);
      assert.strictEqual(res.payload.data.leaveBalances.casual, 12);
    });

    await runTestAsync('1.2 Sarah can check leaves via tool getLeaveBalance', async () => {
      const result = await toolGetLeaveBalance({}, { user: sarah });
      assert.strictEqual(result.userId, sarah.userId);
      assert.strictEqual(result.leaveBalances.casual, 12);
    });

    await runTestAsync('1.3 Sarah is BLOCKED from inspecting James\'s balance (403 Forbidden)', async () => {
      const req = createMockReq({ user: sarah, query: { userId: james.userId } });
      const res = createMockRes();
      await getLeaveBalance(req, res);

      assert.strictEqual(res.statusCode, 403);
      assert.match(res.payload.message, /lacks permission/i);
    });

    await runTestAsync('1.4 Sarah is BLOCKED from inspecting Priya\'s balance via tool (403 ToolExecutionError)', async () => {
      let threw = false;
      try {
        await toolGetLeaveBalance({ userId: priya.userId }, { user: sarah });
      } catch (err) {
        threw = true;
        assert(err instanceof ToolExecutionError);
        assert.strictEqual(err.statusCode, 403);
      }
      assert.strictEqual(threw, true, 'Expected tool execution to throw 403 ToolExecutionError');
    });

    await runTestAsync('1.5 Sarah can view only her own tickets (GET /api/tickets)', async () => {
      const req = createMockReq({ user: sarah });
      const res = createMockRes();
      await getTickets(req, res);

      assert.strictEqual(res.statusCode, 200);
      const tickets = res.payload.data.tickets;
      assert(tickets.every((t) => t.userId === sarah.userId), 'All returned tickets must belong to Sarah');
      assert(!tickets.some((t) => t.userId === priya.userId), 'Priya\'s ticket must NOT appear in Sarah\'s tickets');
    });

    await runTestAsync('1.6 Sarah is BLOCKED from uploading policy documents (requireRoles middleware 403)', async () => {
      const middleware = requireRoles('super_admin', 'org_admin', 'hr_admin', 'it_admin', 'manager');
      const req = createMockReq({ user: sarah });
      const res = createMockRes();
      let nextCalled = false;

      middleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false, 'Middleware must not call next() for employee on admin route');
      assert.strictEqual(res.statusCode, 403);
      assert.match(res.payload.message, /lacks permission/i);
    });

    await runTestAsync('1.7 Sarah can stage and approve her own leave application (applyLeave)', async () => {
      const staged = await stageActionToken({
        type: ACTION_TYPES.APPLY_LEAVE,
        userId: sarah.userId,
        orgId: sarah.orgId,
        payload: {
          leaveType: 'casual',
          days: 2,
          startDate: '2026-12-05',
          endDate: '2026-12-06',
          reason: 'Family event',
        },
        client: redis,
      });

      assert(staged.actionId.startsWith('act_'));

      // Sarah approves her own staged action
      const approveReq = createMockReq({ user: sarah, body: { actionId: staged.actionId } });
      const approveRes = createMockRes();
      await approveAction(approveReq, approveRes);

      assert.strictEqual(approveRes.statusCode, 200);
      assert.strictEqual(approveRes.payload.data.status, 'APPROVED');
      assert.strictEqual(approveRes.payload.data.result.daysDeducted, 2);
    });

    await runTestAsync('1.8 Sarah is BLOCKED from approving James\'s staged leave (403 Forbidden)', async () => {
      const jamesStaged = await stageActionToken({
        type: ACTION_TYPES.APPLY_LEAVE,
        userId: james.userId,
        orgId: james.orgId,
        payload: {
          leaveType: 'casual',
          days: 1,
          startDate: '2026-12-10',
          reason: 'Personal day',
        },
        client: redis,
      });

      // Sarah attempts to approve James's leave
      const approveReq = createMockReq({ user: sarah, body: { actionId: jamesStaged.actionId } });
      const approveRes = createMockRes();
      await approveAction(approveReq, approveRes);

      assert.strictEqual(approveRes.statusCode, 403);
      assert.match(approveRes.payload.message, /lacks permission/i);
    });

    await runTestAsync('1.9 Sarah can stage a hardware upgrade request (requestHardwareUpgrade)', async () => {
      const result = await toolRequestHardware(
        {
          assetType: 'LAPTOP',
          preferredModel: 'MacBook Pro M4 Pro',
          reason: 'Current laptop running out of RAM for local docker containers',
          urgency: 'HIGH',
        },
        { user: sarah, redisClient: redis }
      );

      assert.strictEqual(result.requiresConfirmation, true);
      assert(result.actionId.startsWith('act_'));
      assert.strictEqual(result.card.cardType, 'HITL_APPROVAL_CARD');
    });

    // =========================================================================
    // SUITE 2: Manager (David Miller) Verification
    // =========================================================================
    console.log('\n--- 2. Manager (David Miller) Verification ---');

    await runTestAsync('2.1 David can view team tickets (Sarah + James direct reports)', async () => {
      const req = createMockReq({ user: david });
      const res = createMockRes();
      await getTickets(req, res);

      assert.strictEqual(res.statusCode, 200);
      const tickets = res.payload.data.tickets;
      assert(
        tickets.every((t) => [david.userId, sarah.userId, james.userId].includes(t.userId)),
        'Tickets must only belong to David or his direct reports'
      );
    });

    await runTestAsync('2.2 David can filter specifically for Sarah\'s tickets (GET /api/tickets?userId=emp_101)', async () => {
      const req = createMockReq({ user: david, query: { userId: sarah.userId } });
      const res = createMockRes();
      await getTickets(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert(res.payload.data.tickets.every((t) => t.userId === sarah.userId));
    });

    await runTestAsync('2.3 David is BLOCKED from viewing Priya\'s tickets (403 Forbidden: non-report)', async () => {
      const req = createMockReq({ user: david, query: { userId: priya.userId } });
      const res = createMockRes();
      await getTickets(req, res);

      assert.strictEqual(res.statusCode, 403);
      assert.match(res.payload.message, /direct reports/i);
    });

    await runTestAsync('2.4 David can view Sarah\'s leave balance (GET /api/profile/balance?userId=emp_101)', async () => {
      const req = createMockReq({ user: david, query: { userId: sarah.userId } });
      const res = createMockRes();
      await getLeaveBalance(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.data.userId, sarah.userId);
    });

    await runTestAsync('2.5 David is BLOCKED from viewing Priya\'s leave balance (403 Forbidden: non-report)', async () => {
      const req = createMockReq({ user: david, query: { userId: priya.userId } });
      const res = createMockRes();
      await getLeaveBalance(req, res);

      assert.strictEqual(res.statusCode, 403);
      assert.match(res.payload.message, /direct reports/i);
    });

    await runTestAsync('2.6 David can review and approve team leave request for James', async () => {
      const jamesStaged = await stageActionToken({
        type: ACTION_TYPES.APPLY_LEAVE,
        userId: james.userId,
        orgId: james.orgId,
        payload: {
          leaveType: 'sick',
          days: 1,
          startDate: '2026-12-11',
          reason: 'Doctor appointment',
        },
        client: redis,
      });

      // David (manager) approves James's (direct report) staged action
      const approveReq = createMockReq({ user: david, body: { actionId: jamesStaged.actionId } });
      const approveRes = createMockRes();
      await approveAction(approveReq, approveRes);

      assert.strictEqual(approveRes.statusCode, 200);
      assert.strictEqual(approveRes.payload.data.status, 'APPROVED');
      assert.strictEqual(approveRes.payload.data.result.userId, james.userId);
    });

    await runTestAsync('2.7 David is BLOCKED from approving Priya\'s staged leave (403 Forbidden: non-report)', async () => {
      const priyaStaged = await stageActionToken({
        type: ACTION_TYPES.APPLY_LEAVE,
        userId: priya.userId,
        orgId: priya.orgId,
        payload: {
          leaveType: 'casual',
          days: 1,
          startDate: '2026-12-15',
          reason: 'Holiday shopping',
        },
        client: redis,
      });

      // David attempts to approve Priya's action
      const approveReq = createMockReq({ user: david, body: { actionId: priyaStaged.actionId } });
      const approveRes = createMockRes();
      await approveAction(approveReq, approveRes);

      assert.strictEqual(approveRes.statusCode, 403);
      assert.match(approveRes.payload.message, /lacks permission/i);
    });

    // =========================================================================
    // SUITE 3: IT Admin (Marcus Vance) Verification
    // =========================================================================
    console.log('\n--- 3. IT Admin (Marcus Vance) Verification ---');

    await runTestAsync('3.1 Marcus passes role check for policy upload (requireRoles)', async () => {
      const middleware = requireRoles('super_admin', 'org_admin', 'hr_admin', 'it_admin', 'manager');
      const req = createMockReq({ user: marcus });
      const res = createMockRes();
      let nextCalled = false;

      middleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true, 'IT Admin must be permitted through policy upload route');
      assert.strictEqual(res.statusCode, 200);
    });

    await runTestAsync('3.2 Marcus can view corporate hardware inventory (GET /api/assets)', async () => {
      const req = createMockReq({ user: marcus });
      const res = createMockRes();
      await getAssets(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert(res.payload.data.assets.length >= 2, 'IT Admin must view all assets across organization');
    });

    await runTestAsync('3.3 Marcus can inspect single asset metadata (GET /api/assets/HW-MAC-042)', async () => {
      const req = createMockReq({ user: marcus, params: { assetTag: 'HW-MAC-042' } });
      const res = createMockRes();
      await getAssetByTag(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.data.assetTag, 'HW-MAC-042');
      assert.strictEqual(res.payload.data.assignedTo, sarah.userId);
    });

    await runTestAsync('3.4 Marcus can update hardware asset status (PATCH /api/assets/HW-MON-108)', async () => {
      const req = createMockReq({
        user: marcus,
        params: { assetTag: 'HW-MON-108' },
        body: { status: 'MAINTENANCE', cost: 850 },
      });
      const res = createMockRes();
      await updateAsset(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.data.status, 'MAINTENANCE');
      assert.strictEqual(res.payload.data.cost, 850);
    });

    await runTestAsync('3.5 Sarah is BLOCKED from updating hardware assets (403 Forbidden)', async () => {
      const req = createMockReq({
        user: sarah,
        params: { assetTag: 'HW-MON-108' },
        body: { status: 'IN_STOCK' },
      });
      const res = createMockRes();
      await updateAsset(req, res);

      assert.strictEqual(res.statusCode, 403);
      assert.match(res.payload.message, /Access Denied/i);
    });

    // =========================================================================
    // SUITE 4: HR Admin (Alex Morgan) & Org Admin (Elena Rostova) Verification
    // =========================================================================
    console.log('\n--- 4. HR Admin & Org Admin Verification ---');

    await runTestAsync('4.1 Alex (HR Admin) passes policy upload role check for HR handbooks', async () => {
      const middleware = requireRoles('super_admin', 'org_admin', 'hr_admin', 'it_admin', 'manager');
      const req = createMockReq({ user: alex });
      const res = createMockRes();
      let nextCalled = false;

      middleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true, 'HR Admin must be permitted to ingest policies');
    });

    await runTestAsync('4.2 Alex can inspect Sarah\'s leave balance across departments (GET /api/profile/balance?userId=emp_101)', async () => {
      const req = createMockReq({ user: alex, query: { userId: sarah.userId } });
      const res = createMockRes();
      await getLeaveBalance(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.data.userId, sarah.userId);
    });

    await runTestAsync('4.3 Alex can inspect Priya\'s leave balance (GET /api/profile/balance?userId=emp_103)', async () => {
      const req = createMockReq({ user: alex, query: { userId: priya.userId } });
      const res = createMockRes();
      await getLeaveBalance(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.data.userId, priya.userId);
    });

    await runTestAsync('4.4 Elena (Org Admin) can view all organization tickets without manager boundaries', async () => {
      const req = createMockReq({ user: elena });
      const res = createMockRes();
      await getTickets(req, res);

      assert.strictEqual(res.statusCode, 200);
      const tickets = res.payload.data.tickets;
      const userIds = tickets.map((t) => t.userId);
      assert(userIds.includes(sarah.userId), 'Must include Sarah\'s ticket');
      assert(userIds.includes(priya.userId), 'Must include Priya\'s ticket (different department)');
    });

    await runTestAsync('4.5 Elena (Org Admin) can query any employee balance directly', async () => {
      const req = createMockReq({ user: elena, query: { userId: james.userId } });
      const res = createMockRes();
      await getLeaveBalance(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.data.userId, james.userId);
    });

    // =========================================================================
    // SUITE 5: Multi-Tenant Security & Isolation
    // =========================================================================
    console.log('\n--- 5. Multi-Tenant Security & Isolation ---');

    await runTestAsync('5.1 Foreign tenant cannot view org_abc tickets', async () => {
      const req = createMockReq({ user: foreignUser });
      const res = createMockRes();
      await getTickets(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.data.tickets.length, 0, 'Must not return tickets from other organizations');
    });

    await runTestAsync('5.2 Foreign tenant is BLOCKED from approving org_abc staged action (403 Forbidden)', async () => {
      const stagedOrgAction = await stageActionToken({
        type: ACTION_TYPES.APPLY_LEAVE,
        userId: sarah.userId,
        orgId,
        payload: { leaveType: 'casual', days: 1, startDate: '2026-12-20' },
        client: redis,
      });

      const approveReq = createMockReq({ user: foreignUser, body: { actionId: stagedOrgAction.actionId } });
      const approveRes = createMockRes();
      await approveAction(approveReq, approveRes);

      assert.strictEqual(approveRes.statusCode, 403);
      assert.match(approveRes.payload.message, /Tenant isolation violation/i);
    });

  } finally {
    if (redis && redis.isOpen) {
      await redis.quit();
    }
    await disconnectDB();
  }

  console.log('\n================================================================');
  console.log(`🎉 SPRINT 6 POINT 1 VERIFICATION COMPLETE: ${passedTests}/${totalTests} TESTS PASSED!`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
  process.exit(0);
}

runRoleVerification().catch((err) => {
  console.error('\n❌ Fatal error during Sprint 6 verification:', err);
  process.exit(1);
});
