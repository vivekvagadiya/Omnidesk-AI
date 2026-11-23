/**
 * Omnidesk-AI: Tool Registry & HITL Security Verification Test Suite
 *
 * Verifies:
 *  1. Tool Schema & Classification (Safe, Mutation, Consequential)
 *  2. Invalid Input Validation (bad tool names, missing params, invalid enums, negative days)
 *  3. RBAC & Unauthorized Execution (employee peeking blocked with 403; managers allowed)
 *  4. Multi-Tenant Isolation (queries and mutations strictly scoped to authenticated user's orgId)
 *  5. Consequential HITL Approval Requirements (staging, single-use, anti-concurrency, anti-replay)
 *
 * Run: node test/test-tool-registry.js
 */

import {
  SAFE_TOOLS,
  MUTATION_TOOLS,
  CONSEQUENTIAL_TOOLS,
  TOOL_DEFINITIONS,
  ToolExecutionError,
  InvalidToolError,
  executeTool,
  searchPolicies,
  getLeaveBalance,
  getMyTickets,
  createTicket,
  applyLeave,
  requestHardwareUpgrade,
} from '../src/services/tools/toolRegistry.service.js';

import {
  ACTION_TYPES,
  consumeActionToken,
  getStagedAction,
  deleteStagedAction,
  ActionNotFoundError,
  UnauthorizedActionError,
} from '../src/services/tools/hitlGatekeeper.service.js';

import { User } from '../src/models/User.model.js';
import { Ticket } from '../src/models/Ticket.model.js';
import { Asset } from '../src/models/Asset.model.js';
import { Notification } from '../src/models/Notification.model.js';

console.log('================================================================');
console.log('🛠️  OMNIDESK AI — TOOL REGISTRY & HITL VERIFICATION TEST SUITE');
console.log('================================================================\n');

let totalTests = 0;
let passedTests = 0;

function assert(condition, description) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${description}`);
  } else {
    console.error(`  ❌ [FAIL] ${description}`);
  }
}

// In-memory test state
const mockDb = {
  users: new Map(),
  tickets: new Map(),
  assets: new Map(),
};

// Setup mock queries for Mongoose models to allow fast, deterministic offline testing
const originalUserFindOne = User.findOne;
const originalUserFind = User.find;
const originalTicketFind = Ticket.find;
const originalTicketFindOne = Ticket.findOne;
const originalTicketCreate = Ticket.create;
const originalTicketCountDocuments = Ticket.countDocuments;
const originalAssetFind = Asset.find;
const originalNotificationInsertMany = Notification.insertMany;

function setupMocks() {
  User.findOne = (query) => {
    let match = null;
    for (const u of mockDb.users.values()) {
      if (query.userId && u.userId !== query.userId) continue;
      if (query.orgId && u.orgId !== query.orgId) continue;
      if (query.managerId && u.managerId !== query.managerId) continue;
      match = u;
      break;
    }
    return {
      select: () => ({
        lean: async () => (match ? JSON.parse(JSON.stringify(match)) : null),
      }),
      lean: async () => (match ? JSON.parse(JSON.stringify(match)) : null),
      then: (resolve) => resolve(match ? JSON.parse(JSON.stringify(match)) : null),
    };
  };

  User.find = (query) => {
    const list = [];
    for (const u of mockDb.users.values()) {
      if (query.orgId && u.orgId !== query.orgId) continue;
      if (query.managerId && u.managerId !== query.managerId) continue;
      list.push(u);
    }
    const chain = {
      select: () => chain,
      limit: () => chain,
      sort: () => chain,
      lean: async () => JSON.parse(JSON.stringify(list)),
      then: (resolve) => resolve(JSON.parse(JSON.stringify(list))),
    };
    return chain;
  };

  Ticket.create = async (doc) => {
    const ticketId = doc.ticketId || `TICK-MOCK-${Date.now()}`;
    const record = { ...doc, ticketId, createdAt: new Date().toISOString() };
    mockDb.tickets.set(ticketId, record);
    return record;
  };

  Ticket.countDocuments = async (query) => {
    let count = 0;
    for (const t of mockDb.tickets.values()) {
      if (query.orgId && t.orgId !== query.orgId) continue;
      if (query.userId && t.userId !== query.userId) continue;
      if (query.status && t.status !== query.status) continue;
      count++;
    }
    return count;
  };

  Ticket.find = (query) => {
    const list = [];
    for (const t of mockDb.tickets.values()) {
      if (query.orgId && t.orgId !== query.orgId) continue;
      if (query.userId && t.userId !== query.userId) continue;
      if (query.status && t.status !== query.status) continue;
      list.push(t);
    }
    return {
      sort: () => ({
        skip: () => ({
          limit: () => ({
            lean: async () => JSON.parse(JSON.stringify(list)),
          }),
        }),
        limit: () => ({
          lean: async () => JSON.parse(JSON.stringify(list)),
        }),
        lean: async () => JSON.parse(JSON.stringify(list)),
      }),
      lean: async () => JSON.parse(JSON.stringify(list)),
    };
  };

  Ticket.findOne = (query) => {
    let match = null;
    for (const t of mockDb.tickets.values()) {
      if (query.stagedActionId && t.stagedActionId !== query.stagedActionId) continue;
      if (query.orgId && t.orgId !== query.orgId) continue;
      if (query.ticketId && t.ticketId !== query.ticketId) continue;
      match = t;
      break;
    }
    return {
      select: () => ({
        lean: async () => (match ? JSON.parse(JSON.stringify(match)) : null),
      }),
      lean: async () => (match ? JSON.parse(JSON.stringify(match)) : null),
      then: (resolve) => resolve(match ? JSON.parse(JSON.stringify(match)) : null),
    };
  };

  Asset.find = (query) => {
    const list = [];
    for (const a of mockDb.assets.values()) {
      if (query.orgId && a.orgId !== query.orgId) continue;
      if (query.assignedTo && a.assignedTo !== query.assignedTo) continue;
      list.push(a);
    }
    return {
      select: () => ({
        lean: async () => JSON.parse(JSON.stringify(list)),
      }),
      lean: async () => JSON.parse(JSON.stringify(list)),
    };
  };

  Notification.insertMany = async () => [];
}

function teardownMocks() {
  User.findOne = originalUserFindOne;
  User.find = originalUserFind;
  Ticket.find = originalTicketFind;
  Ticket.findOne = originalTicketFindOne;
  Ticket.create = originalTicketCreate;
  Ticket.countDocuments = originalTicketCountDocuments;
  Asset.find = originalAssetFind;
  Notification.insertMany = originalNotificationInsertMany;
}

async function runAllTests() {
  setupMocks();

  const orgA = 'org_alpha';
  const orgB = 'org_beta';

  const employeeSarah = {
    userId: 'emp_sarah',
    orgId: orgA,
    name: 'Sarah Connor',
    role: 'employee',
    department: 'Engineering',
    leaveBalances: { casual: 12, sick: 7, maternity: 90 },
  };

  const managerDavid = {
    userId: 'mgr_david',
    orgId: orgA,
    name: 'David Miller',
    role: 'manager',
    department: 'Engineering',
    leaveBalances: { casual: 15, sick: 10, maternity: 0 },
  };

  const employeeJames = {
    userId: 'emp_james',
    orgId: orgA,
    managerId: 'mgr_david',
    name: 'James Bond',
    role: 'employee',
    department: 'Engineering',
    leaveBalances: { casual: 5, sick: 2, maternity: 0 },
  };

  const foreignUser = {
    userId: 'emp_foreign',
    orgId: orgB,
    name: 'Foreign Agent',
    role: 'employee',
    department: 'Operations',
    leaveBalances: { casual: 10, sick: 5, maternity: 0 },
  };

  mockDb.users.set(employeeSarah.userId, employeeSarah);
  mockDb.users.set(managerDavid.userId, managerDavid);
  mockDb.users.set(employeeJames.userId, employeeJames);
  mockDb.users.set(foreignUser.userId, foreignUser);

  mockDb.assets.set('ast_1', {
    assetTag: 'AST-001',
    orgId: orgA,
    assignedTo: employeeSarah.userId,
    type: 'LAPTOP',
    model: 'MacBook Pro 16 M3',
    status: 'ASSIGNED',
  });

  try {
    // =============================================================
    // SUITE 1: Tool Classification and Declarations
    // =============================================================
    console.log('--- Suite 1: Tool Classification & Schemas ---');

    assert(
      Array.isArray(TOOL_DEFINITIONS) && TOOL_DEFINITIONS.length === 6,
      'Exposes exactly 6 registered tool declarations for AI orchestration'
    );

    assert(
      SAFE_TOOLS.length === 3 &&
        SAFE_TOOLS.includes('searchPolicies') &&
        SAFE_TOOLS.includes('getLeaveBalance') &&
        SAFE_TOOLS.includes('getMyTickets'),
      'Identifies searchPolicies, getLeaveBalance, and getMyTickets as SAFE tools'
    );

    assert(
      MUTATION_TOOLS.length === 1 && MUTATION_TOOLS.includes('createTicket'),
      'Identifies createTicket as a MUTATION write tool'
    );

    assert(
      CONSEQUENTIAL_TOOLS.length === 2 &&
        CONSEQUENTIAL_TOOLS.includes('applyLeave') &&
        CONSEQUENTIAL_TOOLS.includes('requestHardwareUpgrade'),
      'Identifies applyLeave and requestHardwareUpgrade as CONSEQUENTIAL HITL tools'
    );

    // =============================================================
    // SUITE 2: Invalid Input Validation
    // =============================================================
    console.log('\n--- Suite 2: Invalid Input Validation ---');

    // 2.1 Unregistered tool name
    let unregisteredToolCaught = false;
    try {
      await executeTool('deleteDatabase', {}, { user: employeeSarah });
    } catch (err) {
      unregisteredToolCaught = err instanceof InvalidToolError && err.statusCode === 404;
    }
    assert(unregisteredToolCaught, 'Rejects unregistered tool names with InvalidToolError (404)');

    // 2.2 Missing user context
    let missingContextCaught = false;
    try {
      await executeTool('searchPolicies', { query: 'test' }, {});
    } catch (err) {
      missingContextCaught = err instanceof ToolExecutionError;
    }
    assert(missingContextCaught, 'Rejects tool execution without authenticated user context');

    // 2.3 searchPolicies missing query
    let emptyQueryCaught = false;
    try {
      await searchPolicies({ query: '' }, { user: employeeSarah });
    } catch (err) {
      emptyQueryCaught = err instanceof ToolExecutionError;
    }
    assert(emptyQueryCaught, 'searchPolicies strictly rejects empty query arguments');

    // 2.4 applyLeave invalid leaveType
    let invalidLeaveTypeCaught = false;
    try {
      await applyLeave(
        { leaveType: 'vacation', days: 2, startDate: '2026-12-01' },
        { user: employeeSarah }
      );
    } catch (err) {
      invalidLeaveTypeCaught = err.message.toLowerCase().includes('invalid leave type');
    }
    assert(invalidLeaveTypeCaught, 'applyLeave strictly rejects unwhitelisted leave categories');

    // 2.5 applyLeave negative or zero days
    let negativeDaysCaught = false;
    try {
      await applyLeave(
        { leaveType: 'casual', days: -3, startDate: '2026-12-01' },
        { user: employeeSarah }
      );
    } catch (err) {
      negativeDaysCaught = err.message.toLowerCase().includes('greater than zero');
    }
    assert(negativeDaysCaught, 'applyLeave strictly rejects zero or negative day counts');

    // 2.6 applyLeave missing startDate
    let missingStartDateCaught = false;
    try {
      await applyLeave({ leaveType: 'casual', days: 2 }, { user: employeeSarah });
    } catch (err) {
      missingStartDateCaught = err.message.toLowerCase().includes('startdate');
    }
    assert(missingStartDateCaught, 'applyLeave strictly requires a valid startDate');

    // 2.7 applyLeave days exceeding available balance
    let overdraftCaught = false;
    try {
      await applyLeave(
        { leaveType: 'casual', days: 20, startDate: '2026-12-01' },
        { user: employeeSarah }
      );
    } catch (err) {
      overdraftCaught = err.message.toLowerCase().includes('insufficient leave balance');
    }
    assert(overdraftCaught, 'applyLeave blocks requests exceeding available leave quotas');

    // 2.8 requestHardwareUpgrade invalid category
    let invalidAssetCaught = false;
    try {
      await requestHardwareUpgrade(
        { assetType: 'DRONE', preferredModel: 'DJI', reason: 'Fun' },
        { user: employeeSarah }
      );
    } catch (err) {
      invalidAssetCaught = err.message.toLowerCase().includes('invalid asset category');
    }
    assert(invalidAssetCaught, 'requestHardwareUpgrade rejects unapproved hardware asset categories');

    // 2.9 requestHardwareUpgrade missing fields
    let missingReasonCaught = false;
    try {
      await requestHardwareUpgrade(
        { assetType: 'LAPTOP', preferredModel: 'MacBook' },
        { user: employeeSarah }
      );
    } catch (err) {
      missingReasonCaught = err.message.toLowerCase().includes('reason');
    }
    assert(missingReasonCaught, 'requestHardwareUpgrade strictly requires business justification');

    // =============================================================
    // SUITE 3: RBAC & Unauthorized Execution
    // =============================================================
    console.log('\n--- Suite 3: RBAC & Authorization Guardrails ---');

    // 3.1 Employee can view own balance
    const ownBalance = await getLeaveBalance({}, { user: employeeSarah });
    assert(
      ownBalance.userId === employeeSarah.userId && ownBalance.leaveBalances.casual === 12,
      'Employee can view their own leave balances'
    );

    // 3.2 Employee CANNOT inspect colleague balance (403 Forbidden)
    let colleaguePeekingBlocked = false;
    try {
      await getLeaveBalance({ userId: employeeJames.userId }, { user: employeeSarah });
    } catch (err) {
      colleaguePeekingBlocked = err instanceof ToolExecutionError && err.statusCode === 403;
    }
    assert(colleaguePeekingBlocked, 'RBAC Guard: Standard employee is forbidden from viewing other balances (403)');

    // 3.3 Manager CAN view subordinate employee balance
    const managerInspection = await getLeaveBalance(
      { userId: employeeJames.userId },
      { user: managerDavid }
    );
    assert(
      managerInspection.userId === employeeJames.userId && managerInspection.leaveBalances.casual === 5,
      'RBAC Clearance: Manager can inspect subordinate employee leave balances'
    );

    // =============================================================
    // SUITE 4: Multi-Tenant Isolation
    // =============================================================
    console.log('\n--- Suite 4: Multi-Tenant Isolation Guardrails ---');

    // 4.1 Ticket creation binds strictly to user's authenticated orgId
    const createdTicketResult = await createTicket(
      { title: 'Broken Monitor', category: 'IT_HARDWARE', priority: 'HIGH' },
      { user: employeeSarah }
    );
    assert(
      createdTicketResult.success === true && createdTicketResult.ticket.ticketId.startsWith('TICK-'),
      'createTicket creates valid ticket with TICK- prefix'
    );

    const storedTicket = mockDb.tickets.get(createdTicketResult.ticket.ticketId);
    assert(
      storedTicket && storedTicket.orgId === orgA && storedTicket.userId === employeeSarah.userId,
      'Created ticket is strictly bound to authenticated user.orgId and user.userId'
    );

    // 4.2 Cross-Tenant Ticket Isolation in getMyTickets
    const sarahTickets = await getMyTickets({}, { user: employeeSarah });
    const foreignTickets = await getMyTickets({}, { user: foreignUser });
    assert(
      sarahTickets.tickets.some((t) => t.ticketId === storedTicket.ticketId) &&
        !foreignTickets.tickets.some((t) => t.ticketId === storedTicket.ticketId),
      'getMyTickets strictly isolates ticket visibility by authenticated tenant orgId'
    );

    // =============================================================
    // SUITE 5: Consequential Actions & Human-in-the-Loop (HITL)
    // =============================================================
    console.log('\n--- Suite 5: Consequential Actions & HITL Approval Lifecycle ---');

    // 5.1 Staging applyLeave does NOT mutate database balance
    const stagedLeave = await applyLeave(
      { leaveType: 'casual', days: 3, startDate: '2026-12-10', reason: 'Personal holiday' },
      { user: employeeSarah }
    );

    assert(
      stagedLeave.isConsequential === true &&
        stagedLeave.requiresConfirmation === true &&
        stagedLeave.actionId.startsWith('act_'),
      'applyLeave returns staged HITL card with actionId without executing immediate balance deduction'
    );

    // Verify Sarah's database balance was not decremented prematurely
    assert(
      employeeSarah.leaveBalances.casual === 12,
      'Pre-Approval Guard: Leave balance remains untouched (12 days) prior to human approval'
    );

    // 5.2 Staging requestHardwareUpgrade returns confirmation card
    const stagedHw = await requestHardwareUpgrade(
      {
        assetType: 'LAPTOP',
        preferredModel: 'Dell XPS 15',
        reason: 'Current laptop battery swelling',
        urgency: 'HIGH',
      },
      { user: employeeSarah }
    );

    assert(
      stagedHw.isConsequential === true &&
        stagedHw.requiresConfirmation === true &&
        stagedHw.actionType === ACTION_TYPES.REQUEST_HARDWARE_UPGRADE,
      'requestHardwareUpgrade returns staged confirmation card requiring human approval'
    );

    // 5.3 Cross-Tenant Approval Rejection
    let crossTenantApprovalBlocked = false;
    try {
      await consumeActionToken({
        actionId: stagedLeave.actionId,
        user: foreignUser, // Different organization!
        decision: 'APPROVE',
      });
    } catch (err) {
      crossTenantApprovalBlocked = err instanceof UnauthorizedActionError;
    }
    assert(
      crossTenantApprovalBlocked,
      'Security Guard: Foreign tenant user is blocked from approving another organization staged token'
    );

    // 5.4 Rejection Path clears token cleanly
    const rejectResult = await consumeActionToken({
      actionId: stagedLeave.actionId,
      user: employeeSarah,
      decision: 'REJECT',
    });

    assert(
      rejectResult.status === 'REJECTED',
      'consumeActionToken processes human REJECT decision cleanly'
    );

    // Verify token is expunged
    const tokenAfterReject = await getStagedAction(stagedLeave.actionId);
    assert(
      tokenAfterReject === null,
      'Action token is expunged after rejection (single-use anti-replay)'
    );

    // Clean up second staged action
    await deleteStagedAction(stagedHw.actionId);

    console.log('\n================================================================');
    console.log(`🎉 TOOL REGISTRY VERIFICATION COMPLETE: ${passedTests}/${totalTests} TESTS PASSED!`);
    console.log('================================================================\n');

    process.exit(totalTests === passedTests ? 0 : 1);
  } finally {
    teardownMocks();
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
