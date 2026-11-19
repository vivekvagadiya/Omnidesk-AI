import { GoogleGenAI } from '@google/genai';
import { config } from '../../config/environment.js';
import { getRedisClient } from '../../config/redis.js';
import { retrievePolicyContext } from '../rag/retrieval.service.js';
import { packageResponseWithCitations } from '../rag/citation.service.js';

export const PRIMARY_MODEL = 'gemini-3.8-flash';
export const FALLBACK_MODEL = 'gemini-3.5-flash';

export const SESSION_TTL_SECONDS = 86400; // 24-hour session TTL
export const MAX_SESSION_MESSAGES = 20; // Last 10 turns (user + assistant)

// In-memory fallback session store for offline or disconnected Redis states
const inMemorySessionStore = new Map();

/**
 * Clean up expired in-memory sessions every 10 minutes
 */
const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, session] of inMemorySessionStore.entries()) {
    if (session.expiresAt <= now) {
      inMemorySessionStore.delete(key);
    }
  }
}, 10 * 60 * 1000);

if (sessionCleanupTimer.unref) {
  sessionCleanupTimer.unref();
}

/**
 * Retrieve sliding-window conversation turns from Redis (or in-memory fallback)
 *
 * @param {string} sessionId
 * @param {Object} [client]
 * @returns {Promise<Array<{ role: string, text: string, timestamp: string }>>}
 */
export async function getSessionHistory(sessionId, client = getRedisClient()) {
  if (!sessionId) return [];

  const key = `session:${sessionId}:messages`;

  // 1. Try Redis first
  if (client && client.isOpen) {
    try {
      const rawTurns = await client.lRange(key, -MAX_SESSION_MESSAGES, -1);
      return rawTurns.map((turnStr) => JSON.parse(turnStr));
    } catch (err) {
      console.warn(`⚠️ [Orchestrator] Redis session read error: ${err.message}. Using memory store.`);
    }
  }

  // 2. In-memory fallback
  const record = inMemorySessionStore.get(key);
  if (!record || record.expiresAt <= Date.now()) {
    return [];
  }
  return record.messages || [];
}

/**
 * Append a conversation turn to the Redis session sliding window
 *
 * @param {string} sessionId
 * @param {Object} message { role: 'user'|'model', text: string }
 * @param {Object} [client]
 */
export async function appendSessionMessage(sessionId, message, client = getRedisClient()) {
  if (!sessionId || !message) return;

  const key = `session:${sessionId}:messages`;
  const enrichedMessage = {
    ...message,
    timestamp: message.timestamp || new Date().toISOString(),
  };

  // 1. Try Redis
  if (client && client.isOpen) {
    try {
      await client.rPush(key, JSON.stringify(enrichedMessage));
      await client.lTrim(key, -MAX_SESSION_MESSAGES, -1);
      await client.expire(key, SESSION_TTL_SECONDS);
      return;
    } catch (err) {
      console.warn(`⚠️ [Orchestrator] Redis session write error: ${err.message}. Saving to memory store.`);
    }
  }

  // 2. In-memory fallback
  let record = inMemorySessionStore.get(key);
  if (!record || record.expiresAt <= Date.now()) {
    record = {
      messages: [],
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    };
  }

  record.messages.push(enrichedMessage);
  if (record.messages.length > MAX_SESSION_MESSAGES) {
    record.messages = record.messages.slice(-MAX_SESSION_MESSAGES);
  }
  inMemorySessionStore.set(key, record);
}

/**
 * Clear conversation history for a session
 *
 * @param {string} sessionId
 * @param {Object} [client]
 */
export async function clearSessionHistory(sessionId, client = getRedisClient()) {
  if (!sessionId) return;
  const key = `session:${sessionId}:messages`;

  if (client && client.isOpen) {
    try {
      await client.del(key);
    } catch (err) {
      console.warn(`⚠️ [Orchestrator] Redis session delete error: ${err.message}`);
    }
  }
  inMemorySessionStore.delete(key);
}

/**
 * Assemble the Enterprise System Instructions enforcing Role Boundaries and Evidence Citations
 *
 * @param {Object} params
 * @param {Object} params.user Current authenticated employee
 * @param {string} [params.evidenceContext] RAG evidence context block
 * @returns {string} System instruction string
 */
export function buildSystemInstructions({ user, evidenceContext = '' }) {
  const userName = user?.name || 'Employee';
  const userId = user?.userId || 'unknown';
  const userRole = user?.role || 'employee';
  const orgId = user?.orgId || 'org_abc';
  const department = user?.department || 'General';

  const roleRules = {
    employee:
      '- Role Privileges: Self-service operations only. You can view your own leave balance, active tickets, apply for leaves, and request hardware refreshes.\n- Role Boundaries: You CANNOT approve leave requests or inspect other employees\' sensitive records.',
    manager:
      '- Role Privileges: Team management. You supervise your direct reports, can inspect team leave requests, and approve/reject team actions.\n- Role Boundaries: You cannot alter global organization configuration.',
    hr_admin:
      '- Role Privileges: Human resources administration. You can upload and inspect all HR policies, audit company-wide leave balances, and review HR support tickets.',
    it_admin:
      '- Role Privileges: IT systems and hardware inventory administration. You can upload and inspect IT policies, review hardware asset allocations, and process hardware upgrades.',
    org_admin:
      '- Role Privileges: Complete organization oversight across HR and IT departments.',
    super_admin:
      '- Role Privileges: Platform root owner with diagnostic and tenant provisioning authority.',
  };

  const selectedRoleGuidance = roleRules[userRole] || roleRules.employee;

  return [
    '=== OMNIDESK AI: ENTERPRISE IT & HR OPERATIONS COPILOT ===',
    'You are OmniDesk AI, the autonomous IT and HR operations copilot for ABC Technologies.',
    '',
    '--- CURRENT USER CONTEXT ---',
    `Name        : ${userName}`,
    `Employee ID : ${userId}`,
    `Tenant Org  : ${orgId}`,
    `Department  : ${department}`,
    `User Role   : ${userRole}`,
    '',
    '--- ROLE-BASED ACCESS CONTROL (RBAC) GOVERNANCE ---',
    selectedRoleGuidance,
    '',
    '--- ZERO-HALLUCINATION & CITATION RULES ---',
    '1. When verified policy excerpts are provided below, answer using ONLY that evidence.',
    '2. You MUST cite references using in-text numbered badges like [1], [2], corresponding to the policy sources.',
    '3. If no policy evidence is provided or the topic is not covered, state plainly: "No company policy covers this topic. Would you like me to raise an HR or IT ticket for assistance?"',
    '4. Never fabricate policies, entitlement quotas, or corporate rules.',
    '',
    evidenceContext || 'No verified organization policies attached for this query.',
  ].join('\n');
}

/**
 * Execute an End-to-End Copilot Conversation Turn
 *
 * @param {Object} params
 * @param {string} params.sessionId Unique chat session ID
 * @param {string} params.message Current user message
 * @param {Object} params.user Authenticated employee user object
 * @param {Function} [params.customLlmProvider] Optional mock LLM for testing
 * @param {Function} [params.customEmbeddingProvider] Optional custom embedding provider
 * @param {Object} [params.qdrantClient] Optional custom Qdrant client
 * @returns {Promise<Object>} Formatted response with citations and session metadata
 */
export async function runCopilotTurn({
  sessionId,
  message,
  user,
  customLlmProvider = null,
  customEmbeddingProvider = null,
  qdrantClient = null,
}) {
  if (!sessionId) {
    throw new Error('sessionId is required for copilot conversation.');
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('User message is required.');
  }

  if (!user || !user.orgId) {
    throw new Error('Authenticated user context with orgId is required.');
  }

  // 1. Load Multi-Turn History from Redis
  const historyTurns = await getSessionHistory(sessionId);

  // 2. Perform Evidence-Based RAG Retrieval (with Zero-Hallucination Guardrail)
  const retrievalResult = await retrievePolicyContext({
    query: message,
    user,
    embeddingProvider: customEmbeddingProvider,
    qdrantClient,
  });

  // 3. Assemble System Prompt with Role Boundaries & Policy Context
  const systemInstruction = buildSystemInstructions({
    user,
    evidenceContext: retrievalResult.contextBlock,
  });

  // 4. Generate LLM Response
  let responseText = '';

  if (typeof customLlmProvider === 'function') {
    // Custom/Mock LLM path for deterministic testing
    responseText = await customLlmProvider({
      message,
      history: historyTurns,
      systemInstruction,
      retrievalResult,
    });
  } else {
    // Production Gemini API execution
    if (!config.gemini.apiKey) {
      throw new Error('Gemini API key is missing. Set GEMINI_API_KEY in .env');
    }

    const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

    // Format history for Gemini API
    const contents = historyTurns.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    }));
    contents.push({
      role: 'user',
      parts: [{ text: message }],
    });

    try {
      const response = await ai.models.generateContent({
        model: PRIMARY_MODEL,
        contents,
        config: {
          systemInstruction,
          temperature: 0.2, // Low temperature for high factual accuracy
        },
      });

      responseText =
        response.text?.trim() ||
        response.candidates?.[0]?.content?.parts?.[0]?.text ||
        '';
    } catch (apiErr) {
      // Automatic fallback model attempt if primary is busy
      console.warn(`⚠️ [Orchestrator] Primary model error: ${apiErr.message}. Retrying fallback...`);
      const fallbackResponse = await ai.models.generateContent({
        model: FALLBACK_MODEL,
        contents,
        config: {
          systemInstruction,
          temperature: 0.2,
        },
      });

      responseText =
        fallbackResponse.text?.trim() ||
        fallbackResponse.candidates?.[0]?.content?.parts?.[0]?.text ||
        '';
    }
  }

  // If retrieval was ungrounded and model didn't return text, use guardrail fallback
  if (!retrievalResult.isGrounded && (!responseText || responseText.length < 5)) {
    responseText = retrievalResult.fallbackMessage;
  }

  // 5. Package Citations and Map References
  const packaged = packageResponseWithCitations({
    answerText: responseText,
    chunks: retrievalResult.chunks,
    query: message,
  });

  // 6. Append Turns to Redis Session Memory
  await appendSessionMessage(sessionId, { role: 'user', text: message });
  await appendSessionMessage(sessionId, { role: 'model', text: responseText });

  return {
    sessionId,
    answer: responseText,
    isGrounded: retrievalResult.isGrounded,
    hasCitations: packaged.hasCitations,
    citations: packaged.citations,
    activeCitations: packaged.activeCitations,
    suggestedAction: retrievalResult.suggestedAction || null,
    totalHistoryTurns: historyTurns.length + 2,
  };
}
