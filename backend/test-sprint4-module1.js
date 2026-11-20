import app from './src/app.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import { connectRedis } from './src/config/redis.js';
import { generateTokens } from './src/utils/jwt.js';
import { User } from './src/models/User.model.js';
import { Ticket } from './src/models/Ticket.model.js';
import {
  initSSE,
  sendSSE,
  closeSSE,
} from './src/utils/sse.js';
import {
  streamCopilotTurn,
  detectToolIntent,
} from './src/services/ai/orchestrator.service.js';
import {
  stageActionToken,
  ACTION_TYPES,
} from './src/services/tools/hitlGatekeeper.service.js';
import {
  streamChat,
  approveAction,
  rejectAction,
  getActionDetails,
} from './src/controllers/copilot.controller.js';

console.log('================================================================');
console.log('🚀 OMNIDESK AI — SPRINT 4 MODULE 1: SSE STREAMING & ACTION API');
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

/**
 * Mock Request Generator
 */
function createMockReq({ body = {}, headers = {}, user = null, params = {} } = {}) {
  const listeners = {};
  return {
    body,
    headers,
    user,
    params,
    on(event, handler) {
      listeners[event] = handler;
      return this;
    },
    emit(event, ...args) {
      if (listeners[event]) listeners[event](...args);
    },
  };
}

/**
 * Mock Response Generator with SSE streaming capabilities
 */
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    payload: null,
    headersSent: false,
    writableEnded: false,
    closed: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
      this.closed = true;
      return this;
    },
    setHeader(name, val) {
      this.headers[name.toLowerCase()] = val;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      this.writableEnded = true;
      return this;
    },
    flushHeaders() {},
    flush() {},
  };
  return res;
}

/**
 * Helper to parse raw SSE chunks into an array of { event, data } objects
 */
function parseSSEChunks(rawText) {
  const frames = [];
  const rawBlocks = rawText.split('\n\n');

  for (const block of rawBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    let eventName = 'message';
    let dataStr = '';

    const lines = trimmed.split('\n');
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventName = line.replace('event: ', '').trim();
      } else if (line.startsWith('data: ')) {
        dataStr = line.replace('data: ', '').trim();
      }
    }

    try {
      const parsedData = dataStr ? JSON.parse(dataStr) : null;
      frames.push({ event: eventName, data: parsedData });
    } catch {
      frames.push({ event: eventName, data: dataStr });
    }
  }

  return frames;
}

async function runTests() {
  await connectDB();
  const redis = await connectRedis();

  // In-memory fallback mock for isolated sandbox execution without live MongoDB
  const memUserDb = new Map();
  const memTicketDb = new Map();

  if (User.db?.readyState !== 1) {
    User.create = async function (data) {
      const doc = {
        ...data,
        _id: 'mock_user_' + Date.now(),
        leaveBalances: { ...data.leaveBalances },
        toSafeObject() {
          const copy = { ...this };
          delete copy.password;
          delete copy.__v;
          return copy;
        },
      };
      memUserDb.set(doc.userId, doc);
      if (doc.email) memUserDb.set(doc.email.toLowerCase(), doc);
      return doc;
    };

    User.findOne = function (query) {
      const chain = {
        select() {
          return this;
        },
        lean() {
          return this;
        },
        then(resolve, reject) {
          let match = null;
          if (query.userId) match = memUserDb.get(query.userId);
          else if (query.email) match = memUserDb.get(query.email.toLowerCase());
          return Promise.resolve(match).then(resolve, reject);
        },
        catch(reject) {
          return this.then(null, reject);
        },
      };
      return chain;
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

    User.deleteMany = async function () {
      memUserDb.clear();
      return { acknowledged: true };
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

    Ticket.findOne = function (query) {
      const chain = {
        lean() {
          return this;
        },
        then(resolve, reject) {
          let match = null;
          if (query.ticketId) match = memTicketDb.get(query.ticketId);
          else if (query.stagedActionId) {
            for (const t of memTicketDb.values()) {
              if (t.stagedActionId === query.stagedActionId) {
                match = t;
                break;
              }
            }
          }
          return Promise.resolve(match).then(resolve, reject);
        },
        catch(reject) {
          return this.then(null, reject);
        },
      };
      return chain;
    };

    Ticket.deleteMany = async function () {
      memTicketDb.clear();
      return { acknowledged: true };
    };
  }

  const testOrgId = `org_sprint4_${Date.now()}`;
  const intruderOrgId = `org_intruder_${Date.now()}`;

  const testUser = {
    userId: `emp_s4_${Date.now()}`,
    orgId: testOrgId,
    name: 'Sarah Connor',
    email: `sarah.s4.${Date.now()}@abctech.com`,
    password: 'Password123!',
    role: 'employee',
    department: 'Engineering',
    leaveBalances: {
      casual: 12,
      sick: 7,
      maternity: 90,
    },
    tokenVersion: 1,
    status: 'ACTIVE',
  };

  const intruderUser = {
    userId: `intruder_${Date.now()}`,
    orgId: intruderOrgId,
    name: 'Rogue Employee',
    email: `rogue.${Date.now()}@competitor.com`,
    password: 'Password123!',
    role: 'employee',
    department: 'Finance',
    tokenVersion: 1,
    status: 'ACTIVE',
  };

  let userDoc;

  try {
    userDoc = await User.create(testUser);
    await User.create(intruderUser);

    // =============================================================
    // SUITE 1: SSE Streaming Utility Unit Tests
    // =============================================================
    console.log('\n--- Suite 1: SSE Formatting Utility ---');

    let mockHeaders = {};
    let mockChunks = [];
    const mockRes = {
      writeHead(status, headers) {
        mockHeaders = headers;
        return this;
      },
      write(chunk) {
        mockChunks.push(chunk);
        return true;
      },
      end() {
        this.writableEnded = true;
      },
      writableEnded: false,
    };

    initSSE(mockRes);
    assert(
      mockHeaders['Content-Type'] === 'text/event-stream; charset=utf-8' &&
        mockHeaders['Cache-Control'] === 'no-cache, no-transform' &&
        mockHeaders['Connection'] === 'keep-alive',
      'initSSE writes required Server-Sent Events HTTP headers'
    );

    sendSSE(mockRes, 'token', { delta: 'Hello world' });
    assert(
      mockChunks.length === 1 &&
        mockChunks[0] === 'event: token\ndata: {"delta":"Hello world"}\n\n',
      'sendSSE formats standard SSE frame with event and JSON stringified data'
    );

    closeSSE(mockRes);
    assert(mockRes.writableEnded === true, 'closeSSE cleanly closes the response stream');

    // =============================================================
    // SUITE 2: Intent Detection for Core Operational Tools
    // =============================================================
    console.log('\n--- Suite 2: Tool Intent Detection ---');

    const balanceIntent = detectToolIntent('What is my current leave balance?');
    assert(
      balanceIntent !== null && balanceIntent.tool === 'getLeaveBalance',
      'detectToolIntent maps leave balance inquiry to getLeaveBalance tool'
    );

    const ticketsIntent = detectToolIntent('Show my open tickets');
    assert(
      ticketsIntent !== null &&
        ticketsIntent.tool === 'getMyTickets' &&
        ticketsIntent.args.status === 'OPEN',
      'detectToolIntent maps ticket query to getMyTickets with OPEN status filter'
    );

    const leaveIntent = detectToolIntent('Apply for 3 days casual leave starting 2026-12-01');
    assert(
      leaveIntent !== null &&
        leaveIntent.tool === 'applyLeave' &&
        leaveIntent.args.days === 3 &&
        leaveIntent.args.leaveType === 'casual' &&
        leaveIntent.args.startDate === '2026-12-01',
      'detectToolIntent extracts leave parameters (3 days, casual, 2026-12-01) for applyLeave'
    );

    const hwIntent = detectToolIntent('Request hardware upgrade to MacBook Pro M3');
    assert(
      hwIntent !== null &&
        hwIntent.tool === 'requestHardwareUpgrade' &&
        hwIntent.args.assetType === 'LAPTOP',
      'detectToolIntent maps hardware requisition request to requestHardwareUpgrade'
    );

    // =============================================================
    // SUITE 3: Stream Orchestrator Turn Execution
    // =============================================================
    console.log('\n--- Suite 3: Orchestrator SSE Stream Pipeline ---');

    const emittedEvents = [];
    const testSessionId = `test_sess_s4_${Date.now()}`;

    // Mock stream provider simulating Gemini token streaming
    const mockStreamProvider = async ({ emitToken }) => {
      emitToken('Under ');
      emitToken('our policy [1], ');
      emitToken('casual leave is 12 days.');
    };

    const mockQdrantClient = {
      search: async () => [
        {
          id: 'chunk-hr-1',
          score: 0.92,
          payload: {
            documentName: 'Leave Policy 2026',
            sectionTitle: 'Casual Leave Guidelines',
            department: 'HR',
            allowedRoles: ['employee'],
            text: 'Employees are allocated 12 days of casual leave per calendar year.',
          },
        },
      ],
    };

    const mockEmbedding = async () => new Array(768).fill(0.04);

    await streamCopilotTurn({
      sessionId: testSessionId,
      message: 'What is the casual leave policy?',
      user: testUser,
      onEvent: (event, data) => emittedEvents.push({ event, data }),
      customLlmStreamProvider: mockStreamProvider,
      customEmbeddingProvider: mockEmbedding,
      qdrantClient: mockQdrantClient,
      redisClient: redis,
    });

    const toolEvents = emittedEvents.filter((e) => e.event === 'tool_call');
    const tokenEvents = emittedEvents.filter((e) => e.event === 'token');
    const citationEvents = emittedEvents.filter((e) => e.event === 'citation');
    const doneEvents = emittedEvents.filter((e) => e.event === 'done');

    assert(
      toolEvents.length >= 1 && toolEvents[0].data.tool === 'searchPolicies',
      'streamCopilotTurn emits tool_call event with active status pill'
    );
    assert(
      tokenEvents.length === 3 &&
        tokenEvents.map((t) => t.data.delta).join('') ===
          'Under our policy [1], casual leave is 12 days.',
      'streamCopilotTurn emits incremental token events matching LLM stream chunks'
    );
    assert(
      citationEvents.length === 1 &&
        citationEvents[0].data.hasCitations === true &&
        citationEvents[0].data.citations.length === 1,
      'streamCopilotTurn emits citation event with verified drawer payload'
    );
    assert(
      doneEvents.length === 1 && doneEvents[0].data.sessionId === testSessionId,
      'streamCopilotTurn emits done event confirming turn completion'
    );

    // =============================================================
    // SUITE 4: Controller SSE Chat Endpoint (POST /api/copilot/chat)
    // =============================================================
    console.log('\n--- Suite 4: Controller SSE Chat Endpoint ---');

    // 4.1 Unauthorized Request Protection
    const unauthReq = createMockReq({ body: { message: 'Hello' }, user: null });
    const unauthRes = createMockRes();
    await streamChat(unauthReq, unauthRes);
    assert(
      unauthRes.statusCode === 401,
      'streamChat rejects request without authenticated user (401 Unauthorized)'
    );

    // 4.2 Missing Message Validation
    const emptyMsgReq = createMockReq({ body: { message: '' }, user: testUser });
    const emptyMsgRes = createMockRes();
    await streamChat(emptyMsgReq, emptyMsgRes);
    assert(
      emptyMsgRes.statusCode === 400,
      'streamChat blocks empty message payloads with 400 Bad Request'
    );

    // 4.3 Live Controller SSE Stream Execution
    const chatReq = createMockReq({
      body: {
        sessionId: `sess_ctrl_${Date.now()}`,
        message: 'What is my leave balance?',
      },
      user: testUser,
    });
    const chatRes = createMockRes();
    await streamChat(chatReq, chatRes);

    assert(
      chatRes.statusCode === 200 &&
        chatRes.headers['Content-Type'] === 'text/event-stream; charset=utf-8',
      'streamChat sets 200 OK and text/event-stream headers'
    );

    const rawStreamText = chatRes.chunks.join('');
    const parsedHttpFrames = parseSSEChunks(rawStreamText);

    assert(
      parsedHttpFrames.some((f) => f.event === 'tool_call' && f.data.tool === 'getLeaveBalance'),
      'SSE stream delivers tool_call event for getLeaveBalance execution'
    );
    assert(
      parsedHttpFrames.some(
        (f) => f.event === 'token' && f.data.delta.includes('Casual Leave: 12 days')
      ),
      'SSE stream delivers token chunks with live balance data'
    );
    assert(
      parsedHttpFrames.some((f) => f.event === 'done'),
      'SSE stream concludes with event: done'
    );

    // =============================================================
    // SUITE 5: Consequential Action Staging via Chat Stream
    // =============================================================
    console.log('\n--- Suite 5: Action Staging via SSE Stream ---');

    const actionReq = createMockReq({
      body: {
        sessionId: `sess_action_${Date.now()}`,
        message: 'Apply for 2 days casual leave starting 2026-12-05',
      },
      user: testUser,
    });
    const actionRes = createMockRes();
    await streamChat(actionReq, actionRes);

    const actionStreamText = actionRes.chunks.join('');
    const actionFrames = parseSSEChunks(actionStreamText);

    const actionReqFrame = actionFrames.find((f) => f.event === 'action_required');
    assert(
      actionReqFrame !== undefined &&
        actionReqFrame.data.actionId?.startsWith('act_') &&
        actionReqFrame.data.type === 'APPLY_LEAVE',
      'Chat stream emits event: action_required with staged actionId (act_...) for consequential request'
    );
    assert(
      actionReqFrame.data.card?.cardType === 'HITL_APPROVAL_CARD' &&
        actionReqFrame.data.card.details['Duration'] === '2 day(s)',
      'Delivers complete frontend HITL approval card payload'
    );

    const stagedActionId = actionReqFrame.data.actionId;

    // Verify database was NOT prematurely mutated
    const userCheck = await User.findOne({ userId: testUser.userId });
    assert(
      userCheck.leaveBalances.casual === 12,
      'HITL Security: MongoDB leave balance remains 12 days (no premature mutation)'
    );

    // =============================================================
    // SUITE 6: Action Confirmation Endpoints (Approve & Reject)
    // =============================================================
    console.log('\n--- Suite 6: Action Confirmation Endpoints ---');

    // 6.1 Foreign Tenant Cross-Org Access Block
    const crossTenantReq = createMockReq({
      body: { actionId: stagedActionId },
      user: intruderUser, // Intruder from intruderOrgId!
    });
    const crossTenantRes = createMockRes();
    await approveAction(crossTenantReq, crossTenantRes);
    assert(
      crossTenantRes.statusCode === 403,
      'POST /api/copilot/action/approve blocks foreign tenant from approving token (403 Forbidden)'
    );

    // 6.2 Authorized Action Approval
    const approveReq = createMockReq({
      body: { actionId: stagedActionId },
      user: testUser,
    });
    const approveRes = createMockRes();
    await approveAction(approveReq, approveRes);

    assert(
      approveRes.statusCode === 200,
      'POST /api/copilot/action/approve succeeds with 200 OK for authorized user'
    );

    assert(
      approveRes.payload.success === true && approveRes.payload.data.status === 'APPROVED',
      'Approval response payload confirms status APPROVED'
    );

    const userAfterHttpApprove = await User.findOne({ userId: testUser.userId });
    assert(
      userAfterHttpApprove.leaveBalances.casual === 10,
      'MongoDB leave balance atomically decremented by 2 days (12 -> 10) upon approval'
    );

    // 6.3 Anti-Replay Protection on HTTP endpoint
    const replayReq = createMockReq({
      body: { actionId: stagedActionId },
      user: testUser,
    });
    const replayRes = createMockRes();
    await approveAction(replayReq, replayRes);
    assert(
      replayRes.statusCode === 404,
      'Anti-Replay: Consumed action token returns 404 Not Found on second approval attempt'
    );

    // 6.4 Rejection Endpoint Test
    const freshStaged = await stageActionToken({
      type: ACTION_TYPES.APPLY_LEAVE,
      userId: testUser.userId,
      orgId: testUser.orgId,
      payload: {
        leaveType: 'casual',
        days: 1,
        startDate: '2026-12-10',
      },
      client: redis,
    });

    const rejectReq = createMockReq({
      body: { actionId: freshStaged.actionId },
      user: testUser,
    });
    const rejectRes = createMockRes();
    await rejectAction(rejectReq, rejectRes);

    assert(
      rejectRes.statusCode === 200,
      'POST /api/copilot/action/reject successfully cancels staged action with 200 OK'
    );

    assert(
      rejectRes.payload.data.status === 'REJECTED',
      'Rejection payload confirms status REJECTED'
    );

    const userAfterReject = await User.findOne({ userId: testUser.userId });
    assert(
      userAfterReject.leaveBalances.casual === 10,
      'Balance untouched after rejection (remains 10 days)'
    );

  } finally {
    if (userDoc?._id) {
      await User.deleteMany({ orgId: { $in: [testOrgId, intruderOrgId] } });
      await Ticket.deleteMany({ orgId: { $in: [testOrgId, intruderOrgId] } });
    }

    if (redis && redis.isOpen) {
      await redis.quit();
      console.log('⚡ [Redis] Disconnected gracefully.');
    }

    await disconnectDB();
  }

  console.log('\n================================================================');
  console.log(`🎉 SPRINT 4 MODULE 1 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error in Sprint 4 Module 1:', err);
  process.exit(1);
});
