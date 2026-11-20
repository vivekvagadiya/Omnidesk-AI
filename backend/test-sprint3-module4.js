import { connectDB, disconnectDB } from './src/config/db.js';
import { connectRedis } from './src/config/redis.js';
import { User } from './src/models/User.model.js';
import { Ticket } from './src/models/Ticket.model.js';
import { Asset } from './src/models/Asset.model.js';
import {
  generateActionId,
  buildApprovalCardMetadata,
  stageActionToken,
  getStagedAction,
  deleteStagedAction,
  consumeActionToken,
  ACTION_TYPES,
  ACTION_TOKEN_TTL_SECONDS,
  HITLError,
  ActionNotFoundError,
  ActionExpiredError,
  UnauthorizedActionError,
} from './src/services/tools/hitlGatekeeper.service.js';

console.log('================================================================');
console.log('🛡️  OMNIDESK AI — SPRINT 3 MODULE 4: HITL ACTION GATEKEEPER');
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
  await connectDB();
  const redis = await connectRedis();

  const testOrgId = `org_hitl_${Date.now()}`;
  const intruderOrgId = `org_intruder_${Date.now()}`;

  const testUser = {
    userId: `emp_hitl_${Date.now()}`,
    orgId: testOrgId,
    name: 'Sarah Jenkins',
    email: `sarah.hitl.${Date.now()}@abctech.com`,
    password: 'Password123!',
    role: 'employee',
    department: 'Engineering',
    leaveBalances: {
      casual: 14,
      sick: 8,
      maternity: 90,
    },
  };

  const intruderUser = {
    userId: `usr_intruder_${Date.now()}`,
    orgId: intruderOrgId,
    name: 'Malicious Actor',
    email: `intruder.${Date.now()}@external.com`,
    password: 'Password123!',
    role: 'employee',
    department: 'Finance',
  };

  let createdUser;

  try {
    createdUser = await User.create(testUser);

    // =============================================================
    // SUITE 1: Cryptographic Confirmation Token Generation
    // =============================================================
    console.log('\n--- Suite 1: Cryptographic Action Token Generation ---');

    const actionId1 = generateActionId();
    const actionId2 = generateActionId();

    assert(
      typeof actionId1 === 'string' && actionId1.startsWith('act_') && actionId1.length === 36,
      'generateActionId generates 36-character token with act_ prefix and 32 hex chars'
    );
    assert(actionId1 !== actionId2, 'generateActionId generates non-colliding cryptographically secure IDs');

    // =============================================================
    // SUITE 2: Action Token Staging in Redis (15-min TTL)
    // =============================================================
    console.log('\n--- Suite 2: Action Token Staging & Redis TTL ---');

    const stagedLeave = await stageActionToken({
      type: ACTION_TYPES.APPLY_LEAVE,
      userId: testUser.userId,
      orgId: testUser.orgId,
      payload: {
        leaveType: 'casual',
        days: 4,
        startDate: '2026-12-15',
        endDate: '2026-12-18',
        reason: 'Annual family retreat',
        currentBalance: 14,
        newBalanceAfterApproval: 10,
      },
      summary: 'Request 4 days casual leave from 2026-12-15 to 2026-12-18',
      client: redis,
    });

    assert(
      stagedLeave.actionId && stagedLeave.actionId.startsWith('act_'),
      'stageActionToken returns registered actionId'
    );

    const redisKey = `action:${stagedLeave.actionId}`;
    const isLiveRedis = Boolean(redis && redis.isOpen);

    if (isLiveRedis) {
      const rawData = await redis.get(redisKey);
      const ttlSeconds = await redis.ttl(redisKey);

      assert(rawData !== null, 'Staged action is persisted as JSON string in live Redis');
      assert(
        ttlSeconds > 0 && ttlSeconds <= ACTION_TOKEN_TTL_SECONDS,
        `Redis key has active 15-minute TTL: ${ttlSeconds}s remaining (<= ${ACTION_TOKEN_TTL_SECONDS}s)`
      );

      const parsedData = JSON.parse(rawData);
      assert(
        parsedData.status === 'PENDING_APPROVAL' &&
          parsedData.type === 'APPLY_LEAVE' &&
          parsedData.userId === testUser.userId &&
          parsedData.orgId === testUser.orgId,
        'Stored Redis object contains exact tenant orgId, userId, action type, and PENDING_APPROVAL status'
      );
    } else {
      const retrieved = await getStagedAction(stagedLeave.actionId);
      assert(retrieved !== null, 'Staged action is persisted in in-memory fallback store');
      assert(
        retrieved.status === 'PENDING_APPROVAL' &&
          retrieved.type === 'APPLY_LEAVE' &&
          retrieved.userId === testUser.userId &&
          retrieved.orgId === testUser.orgId,
        'Stored action object contains exact tenant orgId, userId, action type, and PENDING_APPROVAL status'
      );
      assert(
        retrieved.ttlSeconds === ACTION_TOKEN_TTL_SECONDS,
        `Staged action specifies 15-minute TTL: ${retrieved.ttlSeconds}s`
      );
    }

    // =============================================================
    // SUITE 3: Frontend Approval Card Metadata Builder
    // =============================================================
    console.log('\n--- Suite 3: UI Approval Card Metadata ---');

    const leaveCard = stagedLeave.card;
    assert(
      leaveCard.cardType === 'HITL_APPROVAL_CARD' &&
        leaveCard.actionId === stagedLeave.actionId &&
        leaveCard.status === 'PENDING_APPROVAL',
      'Approval card generates standard HITL_APPROVAL_CARD payload'
    );
    assert(
      leaveCard.actions.length === 2 &&
        leaveCard.actions[0].action === 'APPROVE' &&
        leaveCard.actions[1].action === 'REJECT',
      'Approval card contains interactive [Approve] and [Reject] action dispatchers'
    );
    assert(
      leaveCard.details['Leave Type'] === 'CASUAL' &&
        leaveCard.details['Duration'] === '4 day(s)' &&
        leaveCard.details['Remaining After Approval'] === '10 day(s)',
      'Approval card computes before/after impact for employee transparency'
    );

    // =============================================================
    // SUITE 4: Human-in-the-Loop Rejection Flow
    // =============================================================
    console.log('\n--- Suite 4: Decision Flow — Rejection ---');

    const rejectResponse = await consumeActionToken({
      actionId: stagedLeave.actionId,
      user: testUser,
      decision: 'REJECT',
      client: redis,
    });

    assert(
      rejectResponse.status === 'REJECTED' && rejectResponse.success === true,
      'consumeActionToken handles REJECT decision cleanly'
    );

    const userAfterReject = await User.findOne({ userId: testUser.userId });
    assert(
      userAfterReject.leaveBalances.casual === 14,
      'Zero Mutation Guard: User leave balance in MongoDB remains strictly untouched (14 days)'
    );

    if (isLiveRedis) {
      const keyCheckAfterReject = await redis.get(redisKey);
      assert(keyCheckAfterReject === null, 'Action token is permanently expunged from Redis upon rejection');
    } else {
      const keyCheckAfterReject = await getStagedAction(stagedLeave.actionId);
      assert(keyCheckAfterReject === null, 'Action token is permanently expunged from in-memory store upon rejection');
    }

    // =============================================================
    // SUITE 5: Human-in-the-Loop Approval Flow & Atomic Mutation
    // =============================================================
    console.log('\n--- Suite 5: Decision Flow — Approval & Atomic Execution ---');

    // Stage fresh 4 days casual leave
    const freshLeave = await stageActionToken({
      type: ACTION_TYPES.APPLY_LEAVE,
      userId: testUser.userId,
      orgId: testUser.orgId,
      payload: {
        leaveType: 'casual',
        days: 4,
        startDate: '2026-12-20',
        endDate: '2026-12-23',
        reason: 'Holiday vacation',
        currentBalance: 14,
        newBalanceAfterApproval: 10,
      },
      summary: 'Request 4 days casual leave',
      client: redis,
    });

    // Verify balance before approval
    const balanceBeforeApproval = await User.findOne({ userId: testUser.userId });
    assert(
      balanceBeforeApproval.leaveBalances.casual === 14,
      'Pre-Approval Verification: Database balance is untouched prior to human approval'
    );

    const approveResponse = await consumeActionToken({
      actionId: freshLeave.actionId,
      user: testUser,
      decision: 'APPROVE',
      client: redis,
    });

    assert(
      approveResponse.status === 'APPROVED' && approveResponse.success === true,
      'consumeActionToken returns APPROVED status upon confirmation'
    );

    const userAfterApproval = await User.findOne({ userId: testUser.userId });
    assert(
      userAfterApproval.leaveBalances.casual === 10,
      'Atomic Balance Deduction: Casual leave balance decremented exactly by 4 days (14 -> 10)'
    );

    const auditTicket = await Ticket.findOne({ stagedActionId: freshLeave.actionId });
    assert(
      auditTicket !== null &&
        auditTicket.status === 'RESOLVED' &&
        auditTicket.category === 'HR_LEAVE' &&
        auditTicket.metadata.days === 4,
      'Creates permanent audit record Ticket (HR_LEAVE, RESOLVED) in MongoDB linking stagedActionId'
    );

    // =============================================================
    // SUITE 6: Security Defense — Anti-Replay Attack Protection
    // =============================================================
    console.log('\n--- Suite 6: Security Guardrail — Anti-Replay Attack ---');

    let replayErrorCaught = false;
    try {
      await consumeActionToken({
        actionId: freshLeave.actionId,
        user: testUser,
        decision: 'APPROVE',
        client: redis,
      });
    } catch (err) {
      replayErrorCaught = err instanceof ActionNotFoundError;
    }
    assert(
      replayErrorCaught,
      'Anti-Replay Guard: Expunged action token cannot be executed a second time (ActionNotFoundError)'
    );

    // =============================================================
    // SUITE 7: Security Defense — Multi-Tenant Isolation
    // =============================================================
    console.log('\n--- Suite 7: Security Guardrail — Multi-Tenant Isolation ---');

    const crossOrgLeave = await stageActionToken({
      type: ACTION_TYPES.APPLY_LEAVE,
      userId: testUser.userId,
      orgId: testUser.orgId,
      payload: {
        leaveType: 'sick',
        days: 2,
        startDate: '2026-12-28',
      },
      client: redis,
    });

    let tenantBreachBlocked = false;
    try {
      await consumeActionToken({
        actionId: crossOrgLeave.actionId,
        user: intruderUser, // Intruder belongs to intruderOrgId!
        decision: 'APPROVE',
        client: redis,
      });
    } catch (err) {
      tenantBreachBlocked = err instanceof UnauthorizedActionError && err.statusCode === 403;
    }
    assert(
      tenantBreachBlocked,
      'Multi-Tenant Guardrail: Foreign tenant cannot approve action token belonging to another organization (403)'
    );

    await deleteStagedAction(crossOrgLeave.actionId, redis);

    // =============================================================
    // SUITE 8: Hardware Requisition Repertoire Execution
    // =============================================================
    console.log('\n--- Suite 8: Hardware Requisition Flow ---');

    const stagedHardware = await stageActionToken({
      type: ACTION_TYPES.REQUEST_HARDWARE_UPGRADE,
      userId: testUser.userId,
      orgId: testUser.orgId,
      payload: {
        assetType: 'LAPTOP',
        preferredModel: 'Dell XPS 15 9530',
        reason: 'Compiling Rust backend workloads',
        urgency: 'HIGH',
      },
      client: redis,
    });

    assert(
      stagedHardware.card.title === 'Confirm Hardware Requisition: Dell XPS 15 9530',
      'Hardware approval card contains customized hardware specifications'
    );

    const hwApproval = await consumeActionToken({
      actionId: stagedHardware.actionId,
      user: testUser,
      decision: 'APPROVE',
      client: redis,
    });

    assert(
      hwApproval.status === 'APPROVED' && hwApproval.result.ticketId.startsWith('HW-'),
      'Hardware approval generates dedicated HW-... support ticket'
    );

    const createdHwTicket = await Ticket.findOne({ ticketId: hwApproval.result.ticketId });
    assert(
      createdHwTicket !== null &&
        createdHwTicket.category === 'IT_HARDWARE' &&
        createdHwTicket.priority === 'HIGH' &&
        createdHwTicket.status === 'OPEN',
      'Hardware ticket properly recorded in MongoDB with status OPEN and priority HIGH'
    );

  } finally {
    if (createdUser?._id) {
      await User.deleteMany({ orgId: { $in: [testOrgId, intruderOrgId] } });
      await Ticket.deleteMany({ orgId: { $in: [testOrgId, intruderOrgId] } });
      await Asset.deleteMany({ orgId: { $in: [testOrgId, intruderOrgId] } });
    }

    if (redis && redis.isOpen) {
      await redis.quit();
      console.log('⚡ [Redis] Disconnected gracefully.');
    }

    await disconnectDB();
  }

  console.log('\n================================================================');
  console.log(`🎉 SPRINT 3 MODULE 4 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error in Module 4:', err);
  process.exit(1);
});
