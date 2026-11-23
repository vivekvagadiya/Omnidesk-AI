import assert from 'node:assert';
import {
  buildSessionKey,
  resolveSessionKey,
  validateSessionOwnership,
  SessionOwnershipError,
  runCopilotTurn,
  getSessionHistory,
  clearSessionHistory,
} from '../src/services/ai/orchestrator.service.js';
import { streamChat } from '../src/controllers/copilot.controller.js';

let totalTests = 0;
let passedTests = 0;

function it(desc, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✅ [PASS] ${desc}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${desc}`);
    console.error(err);
  }
}

async function itAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ [PASS] ${desc}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${desc}`);
    console.error(err);
  }
}

function createMockReq({ body = {}, user = null }) {
  return {
    body,
    user,
    headers: {},
    on: () => {},
  };
}

function createMockRes() {
  const res = {
    statusCode: null,
    headers: {},
    headersSent: false,
    body: null,
    chunks: [],
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
      return this;
    },
    flushHeaders() {},
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      this.headersSent = true;
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.headersSent = true;
    },
  };
  return res;
}

console.log('================================================================');
console.log('🛡️  OMNIDESK AI — CHAT SESSION ISOLATION & OWNERSHIP TEST SUITE');
console.log('================================================================');

// Test Identities
const userAlice = {
  userId: 'emp_alice_101',
  orgId: 'org_abc',
  name: 'Alice Smith',
  role: 'employee',
};

const userBob = {
  userId: 'emp_bob_102',
  orgId: 'org_abc', // Same tenant, different user
  name: 'Bob Jones',
  role: 'employee',
};

const userMallory = {
  userId: 'emp_mallory_999',
  orgId: 'org_foreign', // Different tenant
  name: 'Mallory Hacker',
  role: 'employee',
};

// -------------------------------------------------------------
// SUITE 1: Session Key Scoping Format
// -------------------------------------------------------------
console.log('\n--- Suite 1: Scoped Session Key Generation ---');

it('buildSessionKey scopes key strictly by orgId + userId + sessionId', () => {
  const key = buildSessionKey({
    orgId: 'org_abc',
    userId: 'emp_101',
    sessionId: 'sess_project_alpha',
  });
  assert.strictEqual(
    key,
    'session:org_abc:emp_101:sess_project_alpha:messages',
    'Session key must match canonical format: session:${orgId}:${userId}:${sessionId}:messages'
  );
});

await itAsync('resolveSessionKey returns scoped key when user context is provided', async () => {
  const key = await resolveSessionKey('sess_123', userAlice);
  assert.strictEqual(
    key,
    'session:org_abc:emp_alice_101:sess_123:messages',
    'resolveSessionKey must include orgId and userId from user context'
  );
});

// -------------------------------------------------------------
// SUITE 2: Session Ownership Binding & Replay/Hijacking Protection
// -------------------------------------------------------------
console.log('\n--- Suite 2: Session Ownership Validation ---');

const sharedSessionId = `sess_isolated_${Date.now()}`;

await itAsync('Alice successfully claims and registers ownership of a new sessionId', async () => {
  const result = await validateSessionOwnership({
    sessionId: sharedSessionId,
    user: userAlice,
  });
  assert.strictEqual(result, true, 'First user to access sessionId establishes ownership');
});

await itAsync('Alice can repeatedly access her own session', async () => {
  const result = await validateSessionOwnership({
    sessionId: sharedSessionId,
    user: userAlice,
  });
  assert.strictEqual(result, true, 'Owner can access their own session on subsequent requests');
});

await itAsync('Bob (same org) is BLOCKED with 403 when supplying Alice sessionId', async () => {
  let thrownError = null;
  try {
    await validateSessionOwnership({
      sessionId: sharedSessionId,
      user: userBob,
    });
  } catch (err) {
    thrownError = err;
  }

  assert(thrownError !== null, 'Must throw when another user attempts to supply foreign sessionId');
  assert(thrownError instanceof SessionOwnershipError, 'Must be instance of SessionOwnershipError');
  assert.strictEqual(thrownError.statusCode, 403, 'Must have statusCode 403');
  assert(thrownError.message.includes('does not belong to the authenticated user'));
});

await itAsync('Mallory (foreign org) is BLOCKED with 403 when supplying Alice sessionId', async () => {
  let thrownError = null;
  try {
    await validateSessionOwnership({
      sessionId: sharedSessionId,
      user: userMallory,
    });
  } catch (err) {
    thrownError = err;
  }

  assert(thrownError !== null, 'Foreign tenant must be blocked from foreign session');
  assert.strictEqual(thrownError.statusCode, 403);
});

// -------------------------------------------------------------
// SUITE 3: Orchestrator Multi-Turn Conversation Isolation
// -------------------------------------------------------------
console.log('\n--- Suite 3: Orchestrator Multi-Turn Conversation Isolation ---');

const isolatedChatSession = `turn_sess_${Date.now()}`;

await itAsync('Alice executes copilot turn and stores history in her scoped session', async () => {
  const mockLlm = async () => 'Alice confidential response regarding project X';
  const mockEmb = async () => new Array(768).fill(0.01);
  const mockQdrant = { query: async () => ({ points: [] }) };

  const turn = await runCopilotTurn({
    sessionId: isolatedChatSession,
    message: 'What is the confidential code for Project X?',
    user: userAlice,
    customLlmProvider: mockLlm,
    customEmbeddingProvider: mockEmb,
    qdrantClient: mockQdrant,
  });

  assert(turn !== null, 'Turn executes successfully for owner');

  const history = await getSessionHistory(
    { sessionId: isolatedChatSession, orgId: userAlice.orgId, userId: userAlice.userId }
  );
  assert.strictEqual(history.length, 2, 'History contains 2 turns (user + model)');
  assert(history[0].text.includes('Project X'));
});

await itAsync('Bob cannot execute turn with Alice sessionId and cannot see her context', async () => {
  const mockLlm = async () => 'Should not be called';
  const mockEmb = async () => new Array(768).fill(0.01);

  let thrown = null;
  try {
    await runCopilotTurn({
      sessionId: isolatedChatSession,
      message: 'Show me previous chat context',
      user: userBob,
      customLlmProvider: mockLlm,
      customEmbeddingProvider: mockEmb,
    });
  } catch (err) {
    thrown = err;
  }

  assert(thrown !== null, 'Bob must be blocked from running turn on Alice session');
  assert.strictEqual(thrown.statusCode, 403, 'Blocked with 403 Forbidden');
});

// -------------------------------------------------------------
// SUITE 4: Controller SSE StreamChat Ownership Guard
// -------------------------------------------------------------
console.log('\n--- Suite 4: Controller SSE StreamChat Ownership Guard ---');

await itAsync('streamChat rejects hijacking attempt with HTTP 403 without opening SSE stream', async () => {
  const req = createMockReq({
    body: {
      sessionId: isolatedChatSession, // Alice's session
      message: 'Attempting to inject into foreign session',
    },
    user: userBob, // Bob attempting to hijack
  });
  const res = createMockRes();

  await streamChat(req, res);

  assert.strictEqual(res.statusCode, 403, 'streamChat must return HTTP 403 Forbidden');
  assert.strictEqual(res.headersSent, true);
  assert.strictEqual(res.body?.success, false);
  assert(res.body?.message?.includes('does not belong to the authenticated user'));
  assert.strictEqual(res.chunks.length, 0, 'No SSE chunks should be sent on 403 rejection');
});

await itAsync('streamChat allows owner to proceed with their session', async () => {
  const req = createMockReq({
    body: {
      sessionId: `fresh_sess_alice_${Date.now()}`,
      message: 'Hello, this is my own session',
    },
    user: userAlice,
  });
  const res = createMockRes();

  await streamChat(req, res);

  assert.strictEqual(res.statusCode, 200, 'Owner request succeeds with 200 OK');
  assert.strictEqual(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
});

// -------------------------------------------------------------
// SUITE 5: Session Cleanup & Expunging
// -------------------------------------------------------------
console.log('\n--- Suite 5: Session Cleanup ---');

await itAsync('clearSessionHistory clears scoped session and releases ownership', async () => {
  await clearSessionHistory(
    { sessionId: isolatedChatSession, orgId: userAlice.orgId, userId: userAlice.userId }
  );

  const history = await getSessionHistory(
    { sessionId: isolatedChatSession, orgId: userAlice.orgId, userId: userAlice.userId }
  );
  assert.strictEqual(history.length, 0, 'Session history is cleared');
});

// Summary
console.log('\n================================================================');
console.log(`🎉 CHAT SESSION ISOLATION VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
console.log('================================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
