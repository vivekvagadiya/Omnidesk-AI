import { connectDB, disconnectDB } from '../src/config/db.js';
import { connectRedis, getRedisClient } from '../src/config/redis.js';
import { User } from '../src/models/User.model.js';
import { Ticket } from '../src/models/Ticket.model.js';
import { Asset } from '../src/models/Asset.model.js';
import {
  searchPolicies,
  getLeaveBalance,
  getMyTickets,
  createTicket,
  applyLeave,
  requestHardwareUpgrade,
  executeTool,
  TOOL_DEFINITIONS,
  SAFE_TOOLS,
  MUTATION_TOOLS,
  CONSEQUENTIAL_TOOLS,
  InvalidToolError,
  ToolExecutionError,
} from '../src/services/tools/toolRegistry.service.js';
import {
  stageActionToken,
  getStagedAction,
  consumeActionToken,
  deleteStagedAction,
  ACTION_TYPES,
  ActionNotFoundError,
  UnauthorizedActionError,
} from '../src/services/tools/hitlGatekeeper.service.js';

console.log('================================================================');
console.log('🛠️  OMNIDESK AI — SPRINT 3 MODULE 3: 6 CORE TOOLS & HITL GATEKEEPER');
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

async function runTests() {
  // Connect to live MongoDB and live Redis
  await connectDB();
  const redis = await connectRedis();

  const testOrgId = `org_test_${Date.now()}`;
  const otherOrgId = `org_other_${Date.now()}`;

  const employeeUser = {
    userId: `emp_${Date.now()}`,
    orgId: testOrgId,
    name: 'Sarah Connor',
    email: `sarah.${Date.now()}@abctech.com`,
    password: 'Password123!',
    role: 'employee',
    department: 'Engineering',
    leaveBalances: {
      casual: 12,
      sick: 7,
      maternity: 90,
    },
  };

  const managerUser = {
    userId: `mgr_${Date.now()}`,
    orgId: testOrgId,
    name: 'David Miller',
    email: `david.${Date.now()}@abctech.com`,
    password: 'Password123!',
    role: 'manager',
    department: 'Engineering',
    leaveBalances: {
      casual: 15,
      sick: 10,
      maternity: 0,
    },
  };

  const otherTenantUser = {
    userId: `intruder_${Date.now()}`,
    orgId: otherOrgId,
    name: 'Intruder Agent',
    email: `intruder.${Date.now()}@competitor.com`,
    password: 'Password123!',
    role: 'employee',
    department: 'Finance',
  };

  let employeeDoc;
  let managerDoc;

  try {
    // Seed test users in MongoDB
    employeeDoc = await User.create(employeeUser);
    managerDoc = await User.create(managerUser);

    // Seed test asset for Sarah
    await Asset.create({
      assetTag: `AST-TEST-${Date.now()}`,
      orgId: testOrgId,
      type: 'LAPTOP',
      model: 'ThinkPad T14 Gen 3',
      assignedTo: employeeUser.userId,
      status: 'ASSIGNED',
    });

    // =============================================================
    // SUITE 1: Tool Registry & Gemini Function Declarations Schema
    // =============================================================
    console.log('\n--- Suite 1: Tool Registry Schema & Classification ---');

    assert(
      Array.isArray(TOOL_DEFINITIONS) && TOOL_DEFINITIONS.length === 6,
      'Registers exactly 6 core tools in Gemini tool definitions schema'
    );

    const toolNames = TOOL_DEFINITIONS.map((t) => t.name);
    assert(
      toolNames.includes('searchPolicies') &&
        toolNames.includes('getLeaveBalance') &&
        toolNames.includes('getMyTickets') &&
        toolNames.includes('createTicket') &&
        toolNames.includes('applyLeave') &&
        toolNames.includes('requestHardwareUpgrade'),
      'Schema declares all 6 tools: searchPolicies, getLeaveBalance, getMyTickets, createTicket, applyLeave, requestHardwareUpgrade'
    );

    assert(
      SAFE_TOOLS.length === 3 &&
        MUTATION_TOOLS.length === 1 &&
        CONSEQUENTIAL_TOOLS.length === 2,
      'Correctly categorizes tools into 3 Safe, 1 Write Mutation, and 2 Consequential HITL tools'
    );

    // Verify Invalid Tool Dispatch
    let caughtInvalidTool = false;
    try {
      await executeTool('nonExistentTool', {}, { user: employeeUser });
    } catch (err) {
      caughtInvalidTool = err instanceof InvalidToolError;
    }
    assert(caughtInvalidTool, 'executeTool rejects unregistered tool names with InvalidToolError');

    // =============================================================
    // SUITE 2: Safe Read Tools (searchPolicies, getLeaveBalance, getMyTickets)
    // =============================================================
    console.log('\n--- Suite 2: Safe Tools Execution ---');

    // 2.1 searchPolicies
    const mockEmbeddingProvider = async () => new Array(768).fill(0.05);
    const mockQdrantClient = {
      search: async () => [
        {
          id: 'chunk-1',
          score: 0.88,
          payload: {
            documentName: 'Leave Policy 2026',
            sectionTitle: 'Annual Leave Accrual',
            department: 'HR',
            allowedRoles: ['employee'],
            text: 'Full-time employees receive 12 days of casual leave annually.',
          },
        },
      ],
    };

    const policyResult = await executeTool(
      'searchPolicies',
      { query: 'How many casual leave days do I get?' },
      {
        user: employeeUser,
        embeddingProvider: mockEmbeddingProvider,
        qdrantClient: mockQdrantClient,
      }
    );

    assert(
      policyResult.tool === 'searchPolicies' && policyResult.isGrounded === true,
      'searchPolicies returns grounded policy excerpts with score above cutoff'
    );
    assert(
      policyResult.chunks.length === 1 && policyResult.chunks[0].score === 0.88,
      'searchPolicies extracts verified chunk metadata (Leave Policy 2026)'
    );

    // 2.2 getLeaveBalance
    const selfBalanceResult = await executeTool(
      'getLeaveBalance',
      {},
      { user: employeeUser }
    );
    assert(
      selfBalanceResult.userId === employeeUser.userId &&
        selfBalanceResult.leaveBalances.casual === 12 &&
        selfBalanceResult.leaveBalances.sick === 7,
      'getLeaveBalance returns authentic leave quotas from MongoDB for authenticated user'
    );

    // RBAC Check on getLeaveBalance
    let employeeBlockedFromPeeking = false;
    try {
      await executeTool(
        'getLeaveBalance',
        { userId: managerUser.userId },
        { user: employeeUser }
      );
    } catch (err) {
      employeeBlockedFromPeeking = err instanceof ToolExecutionError && err.statusCode === 403;
    }
    assert(
      employeeBlockedFromPeeking,
      'RBAC Guardrail: Employee cannot inspect another colleague leave balance (403 Forbidden)'
    );

    // Privileged manager reading subordinate balance
    const managerLookup = await executeTool(
      'getLeaveBalance',
      { userId: employeeUser.userId },
      { user: managerUser }
    );
    assert(
      managerLookup.userId === employeeUser.userId && managerLookup.leaveBalances.casual === 12,
      'RBAC Clearance: Manager can inspect subordinate employee leave balance'
    );

    // =============================================================
    // SUITE 3: Write Tool (createTicket)
    // =============================================================
    console.log('\n--- Suite 3: Write Tool (createTicket) ---');

    const createdTicket = await executeTool(
      'createTicket',
      {
        title: 'Broken USB-C Dock in Conference Room B',
        description: 'Display port flickers continuously when connecting laptop.',
        category: 'IT_HARDWARE',
        priority: 'HIGH',
      },
      { user: employeeUser }
    );

    assert(
      createdTicket.success === true && createdTicket.ticket.ticketId.startsWith('TICK-'),
      'createTicket immediately generates and returns ticketId with TICK- prefix'
    );

    const dbTicket = await Ticket.findOne({ ticketId: createdTicket.ticket.ticketId });
    assert(
      dbTicket !== null &&
        dbTicket.orgId === employeeUser.orgId &&
        dbTicket.userId === employeeUser.userId &&
        dbTicket.priority === 'HIGH' &&
        dbTicket.status === 'OPEN',
      'createTicket inserts valid record into MongoDB with correct orgId, userId, and OPEN status'
    );

    // 2.3 getMyTickets
    const myTicketsResult = await executeTool(
      'getMyTickets',
      { status: 'OPEN' },
      { user: employeeUser }
    );
    assert(
      myTicketsResult.count >= 1 &&
        myTicketsResult.tickets.some((t) => t.ticketId === createdTicket.ticket.ticketId),
      'getMyTickets retrieves newly created open ticket for authenticated employee'
    );

    // =============================================================
    // SUITE 4: Consequential Tool (applyLeave) & HITL Token Staging
    // =============================================================
    console.log('\n--- Suite 4: Consequential Tool (applyLeave) & HITL Staging ---');

    // 4.1 Balance Exhaustion Check
    let insufficientBalanceCaught = false;
    try {
      await executeTool(
        'applyLeave',
        {
          leaveType: 'sick',
          days: 20, // Only 7 available!
          startDate: '2026-12-01',
        },
        { user: employeeUser, redisClient: redis }
      );
    } catch (err) {
      insufficientBalanceCaught = err.message.includes('Insufficient leave balance');
    }
    assert(
      insufficientBalanceCaught,
      'applyLeave enforces balance check and rejects requests exceeding current quota'
    );

    // 4.2 Valid Staging Check
    const leaveStaged = await executeTool(
      'applyLeave',
      {
        leaveType: 'casual',
        days: 3,
        startDate: '2026-12-01',
        endDate: '2026-12-03',
        reason: 'Family vacation',
      },
      { user: employeeUser, redisClient: redis }
    );

    assert(
      leaveStaged.isConsequential === true && leaveStaged.requiresConfirmation === true,
      'applyLeave flags action as consequential requiring explicit human confirmation'
    );
    assert(
      leaveStaged.actionId && leaveStaged.actionId.startsWith('act_'),
      'applyLeave generates cryptographically secure actionId (act_...)'
    );

    // 4.3 CRITICAL VERIFICATION: Database Balance NOT Modified Prematurely!
    const unmutatedUser = await User.findOne({ userId: employeeUser.userId });
    assert(
      unmutatedUser.leaveBalances.casual === 12,
      'CRITICAL HITL GUARD: Calling applyLeave did NOT alter MongoDB balance (still 12 days)'
    );

    // 4.4 Verify Action Token in Live Redis
    const redisKey = `action:${leaveStaged.actionId}`;
    const rawRedisData = await redis.get(redisKey);
    const ttlInRedis = await redis.ttl(redisKey);

    assert(
      rawRedisData !== null && ttlInRedis > 0 && ttlInRedis <= 900,
      `Action token staged directly in Redis with active TTL (${ttlInRedis}s <= 900s)`
    );

    const parsedRedisAction = JSON.parse(rawRedisData);
    assert(
      parsedRedisAction.type === 'APPLY_LEAVE' &&
        parsedRedisAction.payload.days === 3 &&
        parsedRedisAction.userId === employeeUser.userId,
      'Redis action payload contains exact staged parameters (type, days, userId)'
    );

    // 4.5 Verify Approval Card UI Metadata
    assert(
      leaveStaged.card.cardType === 'HITL_APPROVAL_CARD' &&
        leaveStaged.card.actions.some((a) => a.action === 'APPROVE') &&
        leaveStaged.card.actions.some((a) => a.action === 'REJECT'),
      'Returns complete HITL approval card metadata with Approve and Reject actions for UI'
    );

    // =============================================================
    // SUITE 5: HITL Gatekeeper Token Consumption & Atomic DB Execution
    // =============================================================
    console.log('\n--- Suite 5: HITL Consumption & Atomic Mutations ---');

    // 5.1 Rejection Path
    const rejectResult = await consumeActionToken({
      actionId: leaveStaged.actionId,
      user: employeeUser,
      decision: 'REJECT',
      client: redis,
    });

    assert(
      rejectResult.status === 'REJECTED',
      'consumeActionToken successfully processes human REJECT decision'
    );

    const userAfterReject = await User.findOne({ userId: employeeUser.userId });
    assert(
      userAfterReject.leaveBalances.casual === 12,
      'Rejected leave leaves database leave balance untouched (12 days)'
    );

    const keyAfterReject = await redis.get(redisKey);
    assert(
      keyAfterReject === null,
      'Action token is immediately expunged from Redis upon rejection'
    );

    // 5.2 Approval Path: Stage a fresh request for 3 days casual leave
    const freshStaged = await executeTool(
      'applyLeave',
      {
        leaveType: 'casual',
        days: 3,
        startDate: '2026-12-05',
        endDate: '2026-12-07',
        reason: 'Personal errands',
      },
      { user: employeeUser, redisClient: redis }
    );

    const approveResult = await consumeActionToken({
      actionId: freshStaged.actionId,
      user: employeeUser,
      decision: 'APPROVE',
      client: redis,
    });

    assert(
      approveResult.status === 'APPROVED' && approveResult.success === true,
      'consumeActionToken successfully executes human APPROVE decision'
    );

    const userAfterApprove = await User.findOne({ userId: employeeUser.userId });
    assert(
      userAfterApprove.leaveBalances.casual === 9,
      'MongoDB leave balance atomically decremented from 12 to 9 upon explicit approval'
    );

    const leaveAuditTicket = await Ticket.findOne({ stagedActionId: freshStaged.actionId });
    assert(
      leaveAuditTicket !== null &&
        leaveAuditTicket.status === 'RESOLVED' &&
        leaveAuditTicket.category === 'HR_LEAVE',
      'Generates resolved HR_LEAVE audit ticket in MongoDB with stagedActionId reference'
    );

    // 5.3 Anti-Replay Attack Protection
    let replayAttackCaught = false;
    try {
      await consumeActionToken({
        actionId: freshStaged.actionId,
        user: employeeUser,
        decision: 'APPROVE',
        client: redis,
      });
    } catch (err) {
      replayAttackCaught = err instanceof ActionNotFoundError;
    }
    assert(
      replayAttackCaught,
      'Anti-Replay Security: Consumed action token cannot be executed twice (ActionNotFoundError)'
    );

    // =============================================================
    // SUITE 6: Consequential Tool 2 (requestHardwareUpgrade)
    // =============================================================
    console.log('\n--- Suite 6: Hardware Requisition Tool & HITL Execution ---');

    const hwStaged = await executeTool(
      'requestHardwareUpgrade',
      {
        assetType: 'LAPTOP',
        preferredModel: 'MacBook Pro 16-inch M3 Max',
        reason: 'Local AI agent and Docker development requires 64GB RAM.',
        urgency: 'HIGH',
      },
      { user: employeeUser, redisClient: redis }
    );

    assert(
      hwStaged.isConsequential === true &&
        hwStaged.actionType === 'REQUEST_HARDWARE_UPGRADE' &&
        hwStaged.card.details['Preferred Model'] === 'MacBook Pro 16-inch M3 Max',
      'requestHardwareUpgrade stages hardware requisition with assigned asset inspection'
    );

    // Verify Hardware Approval creates IT Ticket
    const hwApproveResult = await consumeActionToken({
      actionId: hwStaged.actionId,
      user: employeeUser,
      decision: 'APPROVE',
      client: redis,
    });

    assert(
      hwApproveResult.status === 'APPROVED' && hwApproveResult.result.ticketId.startsWith('HW-'),
      'Hardware approval generates HW-... support ticket for IT Operations'
    );

    const hwDbTicket = await Ticket.findOne({ ticketId: hwApproveResult.result.ticketId });
    assert(
      hwDbTicket !== null &&
        hwDbTicket.category === 'IT_HARDWARE' &&
        hwDbTicket.priority === 'HIGH' &&
        hwDbTicket.status === 'OPEN',
      'Hardware ticket properly recorded in MongoDB with category IT_HARDWARE and priority HIGH'
    );

    // =============================================================
    // SUITE 7: Multi-Tenant Isolation Security Guardrails
    // =============================================================
    console.log('\n--- Suite 7: Multi-Tenant Isolation Security ---');

    const crossOrgStaged = await executeTool(
      'applyLeave',
      {
        leaveType: 'sick',
        days: 1,
        startDate: '2026-12-10',
      },
      { user: employeeUser, redisClient: redis }
    );

    let crossTenantBreachBlocked = false;
    try {
      await consumeActionToken({
        actionId: crossOrgStaged.actionId,
        user: otherTenantUser, // Different organization!
        decision: 'APPROVE',
        client: redis,
      });
    } catch (err) {
      crossTenantBreachBlocked = err instanceof UnauthorizedActionError;
    }
    assert(
      crossTenantBreachBlocked,
      'Multi-Tenant Isolation: User from another organization cannot consume or approve foreign action token'
    );

    // Cleanup the staged cross-org token
    await deleteStagedAction(crossOrgStaged.actionId, redis);

  } finally {
    // Teardown: Clean up test documents in MongoDB
    if (employeeDoc?._id) {
      await User.deleteMany({ orgId: { $in: [testOrgId, otherOrgId] } });
      await Ticket.deleteMany({ orgId: { $in: [testOrgId, otherOrgId] } });
      await Asset.deleteMany({ orgId: { $in: [testOrgId, otherOrgId] } });
    }

    if (redis && redis.isOpen) {
      await redis.quit();
      console.log('⚡ [Redis] Disconnected gracefully.');
    }

    await disconnectDB();
  }

  console.log('\n================================================================');
  console.log(`🎉 SPRINT 3 MODULE 3 & 4 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
