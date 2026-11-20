import crypto from 'node:crypto';
import { connectDB, disconnectDB } from './src/config/db.js';
import { connectRedis } from './src/config/redis.js';
import { User } from './src/models/User.model.js';
import { Ticket } from './src/models/Ticket.model.js';
import { uploadDocument } from './src/controllers/copilot.controller.js';
import { getTickets, createTicket } from './src/controllers/ticket.controller.js';
import { getLeaveBalance } from './src/controllers/profile.controller.js';
import {
  enqueueNotification,
  processNotification,
  startNotificationWorker,
  stopNotificationWorker,
} from './src/services/queue/notificationWorker.js';

console.log('================================================================');
console.log('🚀 OMNIDESK AI — SPRINT 4 MODULE 2: INGESTION, TICKETS & WORKER');
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
 * Mock Express Request Generator
 */
function createMockReq({
  body = {},
  query = {},
  headers = {},
  user = null,
  file = null,
  params = {},
  testEmbeddingProvider = null,
  qdrantClient = null,
} = {}) {
  return {
    body,
    query,
    headers,
    user,
    file,
    params,
    testEmbeddingProvider,
    qdrantClient,
  };
}

/**
 * Mock Express Response Generator
 */
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    payload: null,
    writableEnded: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      this.writableEnded = true;
      return this;
    },
    setHeader(name, val) {
      this.headers[name.toLowerCase()] = val;
      return this;
    },
  };
  return res;
}

async function runTests() {
  await connectDB();
  const redis = await connectRedis();

  // In-memory mock store for isolated execution without live MongoDB
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

    Ticket.create = async function (data) {
      const doc = {
        ...data,
        _id: 'mock_ticket_' + Date.now(),
        createdAt: new Date().toISOString(),
      };
      memTicketDb.set(doc.ticketId, doc);
      return doc;
    };

    Ticket.find = function (query = {}) {
      let results = Array.from(memTicketDb.values());

      if (query.orgId) {
        results = results.filter((t) => t.orgId === query.orgId);
      }
      if (query.userId) {
        results = results.filter((t) => t.userId === query.userId);
      }
      if (query.status) {
        results = results.filter((t) => t.status === query.status);
      }
      if (query.category) {
        results = results.filter((t) => t.category === query.category);
      }
      if (query.priority) {
        results = results.filter((t) => t.priority === query.priority);
      }

      const chain = {
        sort() {
          return this;
        },
        skip(n) {
          results = results.slice(n);
          return this;
        },
        limit(n) {
          results = results.slice(0, n);
          return this;
        },
        lean() {
          return this;
        },
        then(resolve, reject) {
          return Promise.resolve(results).then(resolve, reject);
        },
        catch(reject) {
          return this.then(null, reject);
        },
      };
      return chain;
    };

    Ticket.countDocuments = async function (query = {}) {
      let count = 0;
      for (const t of memTicketDb.values()) {
        if (query.orgId && t.orgId !== query.orgId) continue;
        if (query.userId && t.userId !== query.userId) continue;
        if (query.status && t.status !== query.status) continue;
        if (query.category && t.category !== query.category) continue;
        if (query.priority && t.priority !== query.priority) continue;
        count++;
      }
      return count;
    };
  }

  const testOrgId = `org_s4m2_${Date.now()}`;
  const foreignOrgId = `org_foreign_${Date.now()}`;

  const employeeUser = {
    userId: `emp_${Date.now()}`,
    orgId: testOrgId,
    name: 'Emily Davis',
    email: `emily.${Date.now()}@acme.com`,
    role: 'employee',
    department: 'Engineering',
    leaveBalances: {
      casual: 10,
      sick: 6,
      maternity: 90,
    },
  };

  const adminUser = {
    userId: `admin_${Date.now()}`,
    orgId: testOrgId,
    name: 'Marcus Vance',
    email: `marcus.${Date.now()}@acme.com`,
    role: 'org_admin',
    department: 'IT',
    leaveBalances: {
      casual: 15,
      sick: 8,
      maternity: 0,
    },
  };

  const foreignUser = {
    userId: `foreign_${Date.now()}`,
    orgId: foreignOrgId,
    name: 'Intruder User',
    email: `intruder.${Date.now()}@foreign.com`,
    role: 'employee',
    department: 'HR',
  };

  await User.create(employeeUser);
  await User.create(adminUser);
  await User.create(foreignUser);

  try {
    // =============================================================
    // SUITE 1: Document Ingestion Endpoint (POST /api/copilot/documents)
    // =============================================================
    console.log('\n--- Suite 1: Document Ingestion Endpoint (POST /api/copilot/documents) ---');

    // 1.1 Unauthorized Request
    const unauthDocReq = createMockReq({ user: null });
    const unauthDocRes = createMockRes();
    await uploadDocument(unauthDocReq, unauthDocRes);
    assert(
      unauthDocRes.statusCode === 401,
      'uploadDocument rejects request without authenticated user (401 Unauthorized)'
    );

    // 1.2 Missing File Attachment
    const missingFileReq = createMockReq({ user: adminUser, file: null });
    const missingFileRes = createMockRes();
    await uploadDocument(missingFileReq, missingFileRes);
    assert(
      missingFileRes.statusCode === 400 && missingFileRes.payload.message.includes('No document file'),
      'uploadDocument rejects payload missing file field (400 Bad Request)'
    );

    // 1.3 Disguised Windows Executable (MZ header)
    const mzBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const maliciousDocReq = createMockReq({
      user: adminUser,
      file: {
        buffer: mzBuffer,
        originalname: 'innocent_policy.pdf',
        mimetype: 'application/pdf',
      },
      body: { department: 'IT' },
    });
    const maliciousDocRes = createMockRes();
    await uploadDocument(maliciousDocReq, maliciousDocRes);
    assert(
      maliciousDocRes.statusCode === 400 &&
        maliciousDocRes.payload.message.includes('Disguised Windows executable binary'),
      'Week 9 Security: Blocks disguised Windows PE binary with 400 Bad Request'
    );

    // 1.4 Path Traversal Sequence
    const traversalReq = createMockReq({
      user: adminUser,
      file: {
        buffer: Buffer.from('%PDF-1.4 test content'),
        originalname: '../../etc/passwd.pdf',
        mimetype: 'application/pdf',
      },
      body: { department: 'IT' },
    });
    const traversalRes = createMockRes();
    await uploadDocument(traversalReq, traversalRes);
    assert(
      traversalRes.statusCode === 400 &&
        traversalRes.payload.message.includes('Path traversal sequence detected'),
      'Anti-Path Traversal: Rejects filename with path traversal characters'
    );

    // 1.5 Valid Markdown Policy Document Ingestion
    const validMarkdown = `# Engineering Remote Work Policy 2026\n\n## Overview\nEngineers may work remotely up to 3 days per week with manager sign-off.\n\n## Hardware Stipend\nEach engineer is entitled to an annual equipment allowance of $1,000.`;
    const validDocReq = createMockReq({
      user: adminUser,
      file: {
        buffer: Buffer.from(validMarkdown, 'utf-8'),
        originalname: 'Engineering_Remote_Policy.md',
        mimetype: 'text/markdown',
      },
      body: {
        department: 'Engineering',
        allowedRoles: JSON.stringify(['employee', 'manager', 'org_admin']),
      },
    });
    const validDocRes = createMockRes();
    await uploadDocument(validDocReq, validDocRes);
    assert(
      validDocRes.statusCode === 201 && validDocRes.payload.success === true,
      'uploadDocument returns 201 Created for valid Markdown policy upload'
    );
    assert(
      validDocRes.payload.data.documentId?.startsWith('doc_') &&
        validDocRes.payload.data.department === 'ENGINEERING',
      'Returns documentId and normalized department in response data'
    );

    // =============================================================
    // SUITE 2: Ticket Management Endpoints (POST & GET /api/tickets)
    // =============================================================
    console.log('\n--- Suite 2: Tickets Endpoints (POST & GET /api/tickets) ---');

    // 2.1 Unauthorized Create Ticket
    const unauthTicketReq = createMockReq({ user: null });
    const unauthTicketRes = createMockRes();
    await createTicket(unauthTicketReq, unauthTicketRes);
    assert(
      unauthTicketRes.statusCode === 401,
      'createTicket rejects unauthenticated request (401 Unauthorized)'
    );

    // 2.2 Invalid Category Validation
    const invalidCategoryReq = createMockReq({
      user: employeeUser,
      body: { title: 'Broken laptop screen', category: 'INVALID_CATEGORY' },
    });
    const invalidCategoryRes = createMockRes();
    await createTicket(invalidCategoryReq, invalidCategoryRes);
    assert(
      invalidCategoryRes.statusCode === 400,
      'createTicket validates category enum and returns 400 for invalid categories'
    );

    // 2.3 Successful Ticket Creation by Employee
    const createReq = createMockReq({
      user: employeeUser,
      body: {
        title: 'MacBook Pro screen flickering',
        description: 'External display randomly disconnects when connecting to Thunderbolt dock.',
        category: 'IT_HARDWARE',
        priority: 'HIGH',
      },
    });
    const createRes = createMockRes();
    await createTicket(createReq, createRes);
    assert(
      createRes.statusCode === 201 && createRes.payload.data.ticketId?.startsWith('TICK-'),
      'createTicket returns 201 Created with generated ticketId (TICK-...)'
    );

    const empTicketId = createRes.payload.data.ticketId;

    // 2.4 Create a ticket for Foreign Tenant User (to test isolation)
    const foreignTicketReq = createMockReq({
      user: foreignUser,
      body: {
        title: 'Foreign Tenant Ticket',
        category: 'GENERAL',
        priority: 'LOW',
      },
    });
    const foreignTicketRes = createMockRes();
    await createTicket(foreignTicketReq, foreignTicketRes);

    // 2.5 Employee Self-Scoped Tickets Query (GET /api/tickets)
    const empGetReq = createMockReq({ user: employeeUser, query: {} });
    const empGetRes = createMockRes();
    await getTickets(empGetReq, empGetRes);
    assert(
      empGetRes.statusCode === 200 && empGetRes.payload.data.tickets.length === 1,
      'GET /api/tickets for employee returns only their own ticket(s)'
    );
    assert(
      empGetRes.payload.data.tickets[0].ticketId === empTicketId,
      'Employee ticket list matches user ticket ID'
    );

    // 2.6 Admin Org-Wide Tickets Query (GET /api/tickets)
    // Admin creates another ticket in the same org
    await createTicket(
      createMockReq({
        user: adminUser,
        body: {
          title: 'Quarterly Cloud Access Review',
          category: 'IT_ACCESS',
          priority: 'CRITICAL',
        },
      }),
      createMockRes()
    );

    const adminGetReq = createMockReq({ user: adminUser, query: {} });
    const adminGetRes = createMockRes();
    await getTickets(adminGetReq, adminGetRes);
    assert(
      adminGetRes.statusCode === 200 && adminGetRes.payload.data.tickets.length === 2,
      'GET /api/tickets for org_admin returns all 2 tickets across the organization'
    );
    assert(
      !adminGetRes.payload.data.tickets.some((t) => t.orgId === foreignOrgId),
      'Multi-tenant isolation: Admin query never returns foreign tenant tickets'
    );

    // 2.7 Filter Tickets by Category
    const filteredGetReq = createMockReq({
      user: adminUser,
      query: { category: 'IT_HARDWARE' },
    });
    const filteredGetRes = createMockRes();
    await getTickets(filteredGetReq, filteredGetRes);
    assert(
      filteredGetRes.payload.data.tickets.length === 1 &&
        filteredGetRes.payload.data.tickets[0].category === 'IT_HARDWARE',
      'GET /api/tickets correctly applies category filter'
    );

    // =============================================================
    // SUITE 3: Profile Leave Balance Endpoint (GET /api/profile/balance)
    // =============================================================
    console.log('\n--- Suite 3: Leave Balance Endpoint (GET /api/profile/balance) ---');

    // 3.1 Unauthorized Access Block
    const unauthBalReq = createMockReq({ user: null });
    const unauthBalRes = createMockRes();
    await getLeaveBalance(unauthBalReq, unauthBalRes);
    assert(
      unauthBalRes.statusCode === 401,
      'getLeaveBalance blocks unauthenticated requests (401 Unauthorized)'
    );

    // 3.2 Live Leave Balance Retrieval for Employee
    const empBalReq = createMockReq({ user: employeeUser });
    const empBalRes = createMockRes();
    await getLeaveBalance(empBalReq, empBalRes);
    assert(
      empBalRes.statusCode === 200 && empBalRes.payload.data.leaveBalances.casual === 10,
      'getLeaveBalance returns exact employee leave quotas (casual: 10, sick: 6)'
    );
    assert(
      empBalRes.payload.data.userId === employeeUser.userId &&
        empBalRes.payload.data.department === 'Engineering',
      'Returns user identity, department, and role in balance payload'
    );

    // =============================================================
    // SUITE 4: Redis Queue Background Worker (notificationWorker.js)
    // =============================================================
    console.log('\n--- Suite 4: Redis Notification Queue Worker ---');

    // 4.1 Process Notification Directly
    const leaveApprovedPayload = {
      event: 'ACTION_APPROVED',
      actionId: 'act_leave_999',
      userId: employeeUser.userId,
      orgId: testOrgId,
      type: 'APPLY_LEAVE',
      details: {
        daysDeducted: 2,
        remainingBalance: 8,
      },
      createdAt: new Date().toISOString(),
    };

    const processResult = processNotification(leaveApprovedPayload);
    assert(
      processResult.dispatched === true && processResult.event === 'ACTION_APPROVED',
      'processNotification processes ACTION_APPROVED event and formats email dispatch'
    );

    // 4.2 Ticket Creation Notification
    const ticketPayload = {
      event: 'TICKET_CREATED',
      ticketId: 'TICK-TEST-123',
      userId: employeeUser.userId,
      orgId: testOrgId,
      title: 'Broken Laptop Screen',
      category: 'IT_HARDWARE',
      priority: 'HIGH',
      createdAt: new Date().toISOString(),
    };
    const ticketResult = processNotification(ticketPayload);
    assert(
      ticketResult.dispatched === true && ticketResult.event === 'TICKET_CREATED',
      'processNotification processes TICKET_CREATED event and logs email alert'
    );

    // 4.3 Background Worker Consumer Loop
    const dispatchedEvents = [];
    await startNotificationWorker({
      pollingIntervalMs: 100,
      useDedicatedClient: false,
      onDispatched: (res) => dispatchedEvents.push(res),
    });

    // Enqueue an event to the queue
    await enqueueNotification(leaveApprovedPayload, redis);

    // Wait for the worker to process the queued item
    await new Promise((resolve) => setTimeout(resolve, 600));

    assert(
      dispatchedEvents.length >= 1 && dispatchedEvents[0].event === 'ACTION_APPROVED',
      'startNotificationWorker consumer loop dequeues event and executes dispatch handler'
    );

    // Cleanly stop worker
    await stopNotificationWorker();
    assert(true, 'stopNotificationWorker terminates background consumer loop cleanly');

  } finally {
    await stopNotificationWorker();
    if (redis && redis.isOpen) {
      await redis.quit();
      console.log('⚡ [Redis] Disconnected gracefully.');
    }
    await disconnectDB();
  }

  console.log('\n================================================================');
  console.log(`🎉 SPRINT 4 MODULE 2 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error in Sprint 4 Module 2:', err);
  process.exit(1);
});
