import {
  getSessionHistory,
  appendSessionMessage,
  clearSessionHistory,
  buildSystemInstructions,
  runCopilotTurn,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  MAX_SESSION_MESSAGES,
  SESSION_TTL_SECONDS,
} from "../src/services/ai/orchestrator.service.js";
import { generateTestEmbedding } from "../src/services/rag/ingestion.service.js";
import { connectRedis, disconnectRedis } from "../src/config/redis.js";

console.log("================================================================");
console.log(
  "🤖 OMNIDESK AI — SPRINT 3 MODULE 1: AI ORCHESTRATOR & LIVE REDIS MEMORY",
);
console.log(
  "================================================================\n",
);

let totalTests = 0;
let passedTests = 0;

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
// TEST SUITE 1: Actual Live Redis Sliding-Window Session Memory
// =============================================================
console.log("--- Suite 1: Live Redis Sliding-Window Session Memory ---");

// Connect to the actual Redis instance
const redisClient = await connectRedis();
const isLiveRedis = Boolean(redisClient && redisClient.isOpen);

assert(
  isLiveRedis === true,
  `Connects to actual live Redis instance at ${redisClient?.options?.url || "redis://127.0.0.1:6380"}`,
);

const testSessionId = `test_sess_${Date.now()}`;
const redisKey = `session:${testSessionId}:messages`;

// 1.1: Clear history
await clearSessionHistory(testSessionId, redisClient);
const emptyHistory = await getSessionHistory(testSessionId, redisClient);
assert(
  Array.isArray(emptyHistory) && emptyHistory.length === 0,
  "clearSessionHistory deletes Redis key and returns empty array",
);

// Verify directly on Redis key
if (isLiveRedis) {
  const existsBefore = await redisClient.exists(redisKey);
  assert(
    existsBefore === 0,
    "Direct Redis Check: Key does not exist in Redis after clear",
  );
}

// 1.2: Append user and model messages to live Redis
await appendSessionMessage(
  testSessionId,
  { role: "user", text: "Hi, I need help with my leave." },
  redisClient,
);
await appendSessionMessage(
  testSessionId,
  { role: "model", text: "Hello! I can help check your leave balance." },
  redisClient,
);

const historyAfterTwo = await getSessionHistory(testSessionId, redisClient);
assert(
  historyAfterTwo.length === 2 &&
    historyAfterTwo[0].role === "user" &&
    historyAfterTwo[1].role === "model",
  "appendSessionMessage writes JSON turns to live Redis list via rPush",
);

// Verify direct Redis list length and TTL
if (isLiveRedis) {
  const directLen = await redisClient.lLen(redisKey);
  const ttl = await redisClient.ttl(redisKey);
  assert(
    directLen === 2 && ttl > 0 && ttl <= SESSION_TTL_SECONDS,
    `Direct Redis Check: lLen is exactly 2, and key has active TTL (${ttl}s / ${SESSION_TTL_SECONDS}s)`,
  );
  console.log(
    `    ↳ Verified on actual Redis: lLen=${directLen}, TTL=${ttl}s, Key='${redisKey}'`,
  );
}

// 1.3: Sliding-window cap at MAX_SESSION_MESSAGES (20) using Redis lTrim
for (let i = 0; i < 25; i++) {
  await appendSessionMessage(
    testSessionId,
    { role: "user", text: `Turn ${i}` },
    redisClient,
  );
}

const cappedHistory = await getSessionHistory(testSessionId, redisClient);
assert(
  cappedHistory.length === MAX_SESSION_MESSAGES,
  `Redis lTrim caps list at exactly ${MAX_SESSION_MESSAGES} messages (10 turns) to protect token budget`,
);

if (isLiveRedis) {
  const cappedRedisLen = await redisClient.lLen(redisKey);
  assert(
    cappedRedisLen === MAX_SESSION_MESSAGES,
    `Direct Redis Check: Actual Redis list length after 27 pushes is strictly ${cappedRedisLen}`,
  );
}

// =============================================================
// TEST SUITE 2: System Instruction Assembly & Role Governance
// =============================================================
console.log("\n--- Suite 2: System Instructions & Role Governance ---");

const employeeUser = {
  name: "Sarah Jenkins",
  userId: "emp_101",
  role: "employee",
  orgId: "org_abc",
  department: "Engineering",
};

const managerUser = {
  name: "David Miller",
  userId: "mgr_201",
  role: "manager",
  orgId: "org_abc",
  department: "Engineering",
};

// 2.1: Employee role instructions
const empPrompt = buildSystemInstructions({
  user: employeeUser,
  evidenceContext: "EVIDENCE EXCERPT",
});

assert(
  empPrompt.includes("Sarah Jenkins") &&
    empPrompt.includes("User Role   : employee") &&
    empPrompt.includes("Self-service operations only") &&
    empPrompt.includes("CANNOT approve leave requests"),
  "Builds employee system instructions enforcing self-service bounds and prohibiting unauthorized approvals",
);

// 2.2: Manager role instructions
const mgrPrompt = buildSystemInstructions({
  user: managerUser,
});

assert(
  mgrPrompt.includes("David Miller") &&
    mgrPrompt.includes("User Role   : manager") &&
    mgrPrompt.includes("approve/reject team actions"),
  "Builds manager system instructions granting team supervision and approval privileges",
);

// =============================================================
// TEST SUITE 3: End-to-End Copilot Turn with Live Redis
// =============================================================
console.log("\n--- Suite 3: End-to-End Copilot Turn with Live Redis ---");

const turnSessionId = `turn_sess_${Date.now()}`;

// Mock Qdrant client returning verified leave policy
const mockQdrantClient = {
  query: async () => ({
    points: [
      {
        id: "chunk_leave_01",
        score: 0.91,
        payload: {
          documentId: "doc_leave_2026",
          documentName: "Employee_Leave_Policy.pdf",
          sectionTitle: "Casual Leave Entitlement",
          text: "Full-time employees receive 12 casual leaves and 7 sick leaves annually.",
          department: "HR",
          orgId: "org_abc",
        },
      },
    ],
  }),
};

// Mock LLM answering using retrieved evidence
const mockLlmProvider = async ({
  message,
  systemInstruction,
  retrievalResult,
}) => {
  assert(
    systemInstruction.includes(
      "=== VERIFIED ORGANIZATION POLICY EVIDENCE ===",
    ) && systemInstruction.includes("Employee_Leave_Policy.pdf"),
    "Orchestrator injects verified policy evidence into the LLM system prompt",
  );

  return "According to company policy [1], you are entitled to 12 casual leaves per year.";
};

const turnResult = await runCopilotTurn({
  sessionId: turnSessionId,
  message: "How many casual leaves do I have?",
  user: employeeUser,
  customLlmProvider: mockLlmProvider,
  customEmbeddingProvider: generateTestEmbedding,
  qdrantClient: mockQdrantClient,
});

assert(
  turnResult.isGrounded === true &&
    turnResult.hasCitations === true &&
    turnResult.activeCitations.length === 1 &&
    turnResult.activeCitations[0].documentName === "Employee_Leave_Policy.pdf",
  "Copilot turn executes RAG retrieval, invokes LLM, and binds in-text citation [1] to policy drawer",
);

// Verify conversation turns stored in actual Redis session memory
const sessionAfterTurn = await getSessionHistory(turnSessionId, redisClient);
assert(
  sessionAfterTurn.length === 2 &&
    sessionAfterTurn[0].text === "How many casual leaves do I have?" &&
    sessionAfterTurn[1].text.includes("12 casual leaves per year"),
  "Saves user query and assistant answer directly into live Redis session history",
);

// =============================================================
// TEST SUITE 4: Zero-Hallucination Fallback in Orchestrator
// =============================================================
console.log("\n--- Suite 4: Zero-Hallucination Fallback in Orchestrator ---");

// Mock empty Qdrant results (out-of-scope question)
const mockEmptyQdrant = {
  query: async () => ({ points: [] }),
};

const ungroundedSessionId = `ungrounded_sess_${Date.now()}`;
const ungroundedTurn = await runCopilotTurn({
  sessionId: ungroundedSessionId,
  message: "Can I bring my pet llama to the office?",
  user: employeeUser,
  customLlmProvider: async ({ retrievalResult }) => {
    return retrievalResult.fallbackMessage;
  },
  customEmbeddingProvider: generateTestEmbedding,
  qdrantClient: mockEmptyQdrant,
});

assert(
  ungroundedTurn.isGrounded === false &&
    ungroundedTurn.answer.includes("No company policy covers this topic") &&
    ungroundedTurn.suggestedAction?.type === "createTicket",
  "Orchestrator safely returns zero-hallucination fallback when no policy covers the topic",
);
console.log("    ↳ Ungrounded Answer:", ungroundedTurn.answer);

// =============================================================
// CLEANUP & TEARDOWN
// =============================================================
// Clean up test keys from Redis
await clearSessionHistory(testSessionId, redisClient);
await clearSessionHistory(turnSessionId, redisClient);
await clearSessionHistory(ungroundedSessionId, redisClient);

// Disconnect Redis gracefully
await disconnectRedis();

console.log(
  "\n================================================================",
);
console.log(
  `🎉 SPRINT 3 MODULE 1 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`,
);
console.log(
  "================================================================\n",
);

process.exit(totalTests === passedTests ? 0 : 1);
