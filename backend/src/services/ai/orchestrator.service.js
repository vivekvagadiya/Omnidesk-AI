import { GoogleGenAI } from '@google/genai';
import { config } from '../../config/environment.js';
import { getRedisClient } from '../../config/redis.js';
import { retrievePolicyContext } from '../rag/retrieval.service.js';
import { packageResponseWithCitations } from '../rag/citation.service.js';
import { maskPII, unmaskPII } from './piiMasker.service.js';
import {
  executeTool,
  TOOL_DEFINITIONS,
  CONSEQUENTIAL_TOOLS,
} from '../tools/toolRegistry.service.js';
import { recordAuditLog } from '../audit/audit.service.js';

export const PRIMARY_MODEL = 'gemini-2.5-flash';
export const FALLBACK_MODEL = 'gemini-2.0-flash';

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

  // 1. Pre-LLM PII Masking (Surrogate Tokenization Guardrail)
  const { maskedText, tokenMap, hasPII } = maskPII(message);

  // 2. Load Multi-Turn History from Redis
  const historyTurns = await getSessionHistory(sessionId);

  // 3. Perform Evidence-Based RAG Retrieval (with Zero-Hallucination Guardrail)
  const retrievalResult = await retrievePolicyContext({
    query: maskedText, // Query using sanitized text
    user,
    embeddingProvider: customEmbeddingProvider,
    qdrantClient,
  });

  // 4. Assemble System Prompt with Role Boundaries & Policy Context
  const systemInstruction = buildSystemInstructions({
    user,
    evidenceContext: retrievalResult.contextBlock,
  });

  // 5. Generate LLM Response
  let responseText = '';

  if (typeof customLlmProvider === 'function') {
    // Custom/Mock LLM path for deterministic testing
    responseText = await customLlmProvider({
      message: maskedText,
      history: historyTurns,
      systemInstruction,
      retrievalResult,
      tokenMap,
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
      parts: [{ text: maskedText }],
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

  // 6. Post-LLM De-Tokenization: Restore raw values from surrogate tokens
  const unmaskedAnswer = hasPII ? unmaskPII(responseText, tokenMap) : responseText;

  // 7. Package Citations and Map References
  const packaged = packageResponseWithCitations({
    answerText: unmaskedAnswer,
    chunks: retrievalResult.chunks,
    query: message,
  });

  // 8. Append Turns to Redis Session Memory
  await appendSessionMessage(sessionId, { role: 'user', text: message });
  await appendSessionMessage(sessionId, { role: 'model', text: unmaskedAnswer });

  return {
    sessionId,
    answer: unmaskedAnswer,
    isGrounded: retrievalResult.isGrounded,
    hasCitations: packaged.hasCitations,
    hasPII,
    piiMasked: hasPII,
    citations: packaged.citations,
    activeCitations: packaged.activeCitations,
    suggestedAction: retrievalResult.suggestedAction || null,
    totalHistoryTurns: historyTurns.length + 2,
  };
}

/**
 * Detect if user query targets one of the registered operational tools
 *
 * @param {string} message
 * @returns {{ tool: string, args: Object } | null}
 */
export function detectToolIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const text = message.toLowerCase().trim();

  // 1. Leave Balance Inquiry
  if (
    /leave\s+balance|how\s+many\s+(?:casual|sick|maternity)?\s*(?:days|leaves)\s+(?:do\s+i\s+have|remaining|left)/i.test(
      text
    )
  ) {
    return { tool: 'getLeaveBalance', args: {} };
  }

  // 2. Tickets Inquiry
  if (/(?:show|view|get|list|my)\s+(?:open\s+)?tickets/i.test(text)) {
    const status = text.includes('open') ? 'OPEN' : 'ALL';
    return { tool: 'getMyTickets', args: { status } };
  }

  // 3. Apply Leave (Consequential / HITL)
  const leaveMatch = text.match(
    /apply\s+(?:for\s+)?(\d+)\s+days?\s+(?:of\s+)?(casual|sick|maternity)\s+(?:leave\s+)?(?:starting|from)?\s*(\d{4}-\d{2}-\d{2})/i
  );
  if (leaveMatch) {
    return {
      tool: 'applyLeave',
      args: {
        days: parseInt(leaveMatch[1], 10),
        leaveType: leaveMatch[2].toLowerCase(),
        startDate: leaveMatch[3],
        reason: 'Requested via Copilot Chat',
      },
    };
  }

  // 4. Request Hardware Upgrade (Consequential / HITL)
  if (
    /request\s+(?:hardware|upgrade|new\s+laptop|new\s+monitor)/i.test(text) ||
    /upgrade\s+my\s+(?:laptop|hardware|monitor|workstation)/i.test(text)
  ) {
    const assetType = text.includes('monitor') ? 'MONITOR' : 'LAPTOP';
    let model = 'High-Performance Workstation';
    if (text.includes('macbook')) model = 'MacBook Pro 16-inch M3 Max';
    else if (text.includes('dell') || text.includes('xps')) model = 'Dell XPS 15 9530';
    else if (text.includes('thinkpad')) model = 'ThinkPad T14 Gen 4';

    return {
      tool: 'requestHardwareUpgrade',
      args: {
        assetType,
        preferredModel: model,
        reason: 'Requested via Copilot Chat',
        urgency: 'MEDIUM',
      },
    };
  }

  return null;
}

/**
 * Execute an End-to-End Streaming Copilot Conversation Turn using SSE
 * Emits real-time SSE events:
 *   - 'tool_call': Dynamic status pills for tools being executed
 *   - 'token': Incremental text chunks
 *   - 'citation': Rich citation drawer metadata payload
 *   - 'action_required': Staged HITL approval card for consequential actions
 *   - 'done': Finalization metadata and turn count
 *
 * @param {Object} params
 * @param {string} params.sessionId Unique chat session ID
 * @param {string} params.message Current user message
 * @param {Object} params.user Authenticated employee user object
 * @param {Function} params.onEvent Event callback: (eventName, payload) => void
 * @param {Function} [params.customLlmStreamProvider] Optional mock stream provider for testing
 * @param {Function} [params.customEmbeddingProvider] Optional custom embedding provider
 * @param {Object} [params.qdrantClient] Optional custom Qdrant client
 * @param {Object} [params.redisClient] Optional custom Redis client
 * @param {Object} [params.explicitToolCall] Optional direct tool trigger from client
 * @returns {Promise<Object>} Final turn summary
 */
export async function streamCopilotTurn({
  sessionId,
  message,
  user,
  onEvent,
  customLlmStreamProvider = null,
  customEmbeddingProvider = null,
  qdrantClient = null,
  redisClient = getRedisClient(),
  explicitToolCall = null,
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

  if (typeof onEvent !== 'function') {
    throw new Error('onEvent callback function is required for SSE streaming.');
  }

  // 1. Pre-LLM PII Masking (Surrogate Tokenization Guardrail)
  const { maskedText, tokenMap, hasPII } = maskPII(message);

  // 2. Load Multi-Turn History from Redis
  const historyTurns = await getSessionHistory(sessionId, redisClient);

  let accumulatedText = '';
  let citationsPayload = { hasCitations: false, citations: [], activeCitations: [] };
  let stagedActionPayload = null;

  // 3. Tool Intent Evaluation
  const detectedTool = explicitToolCall || detectToolIntent(message);

  if (detectedTool && detectedTool.tool !== 'searchPolicies') {
    // A. Emit tool_call event for dynamic status pill
    onEvent('tool_call', {
      tool: detectedTool.tool,
      status: `Executing: ${detectedTool.tool}...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const toolResult = await executeTool(
        detectedTool.tool,
        detectedTool.args || {},
        {
          user,
          redisClient,
          embeddingProvider: customEmbeddingProvider,
          qdrantClient,
        }
      );

      // Check if tool is consequential (HITL Gatekeeper triggered)
      if (toolResult.isConsequential && toolResult.requiresConfirmation) {
        stagedActionPayload = {
          actionId: toolResult.actionId,
          type: toolResult.actionType,
          card: toolResult.card,
          summary: toolResult.summary,
        };

        // Emit action_required event for frontend approval card
        onEvent('action_required', stagedActionPayload);

        accumulatedText =
          toolResult.message ||
          `I have staged your ${toolResult.actionType} request. Please confirm or decline using the approval card below.`;
      } else if (detectedTool.tool === 'getLeaveBalance') {
        accumulatedText = `Here are your current leave balances, ${toolResult.name || user.name || 'there'}:\n- Casual Leave: ${toolResult.leaveBalances.casual} days\n- Sick Leave: ${toolResult.leaveBalances.sick} days\n- Maternity Leave: ${toolResult.leaveBalances.maternity} days`;
      } else if (detectedTool.tool === 'getMyTickets') {
        if (!toolResult.tickets || toolResult.tickets.length === 0) {
          accumulatedText = 'You currently have no open support tickets on record.';
        } else {
          const ticketLines = toolResult.tickets
            .slice(0, 5)
            .map((t) => `- [${t.ticketId}] (${t.status}) ${t.title} [${t.priority} Priority]`)
            .join('\n');
          accumulatedText = `Here are your recent tickets:\n${ticketLines}`;
        }
      } else if (detectedTool.tool === 'createTicket') {
        accumulatedText = `Support Ticket **${toolResult.ticket.ticketId}** has been opened successfully under category **${toolResult.ticket.category}** with **${toolResult.ticket.priority}** priority.`;
      } else {
        accumulatedText = JSON.stringify(toolResult);
      }

      // Stream the synthesized tool response delta
      onEvent('token', { delta: accumulatedText });
    } catch (toolErr) {
      accumulatedText = `⚠️ Error executing ${detectedTool.tool}: ${toolErr.message}`;
      onEvent('token', { delta: accumulatedText });
    }
  } else {
    // B. Semantic Policy Search Path (Evidence-Based RAG)
    onEvent('tool_call', {
      tool: 'searchPolicies',
      status: 'Searching ABC Tech policy knowledge base in Qdrant...',
      timestamp: new Date().toISOString(),
    });

    const retrievalResult = await retrievePolicyContext({
      query: (detectedTool && detectedTool.args?.query) || maskedText,
      user,
      embeddingProvider: customEmbeddingProvider,
      qdrantClient,
    });

    const systemInstruction = buildSystemInstructions({
      user,
      evidenceContext: retrievalResult?.contextBlock || '',
    });

    // Generate tokens from LLM
    if (typeof customLlmStreamProvider === 'function') {
      await customLlmStreamProvider({
        message: maskedText,
        history: historyTurns,
        systemInstruction,
        retrievalResult,
        tokenMap,
        emitToken: (delta) => {
          accumulatedText += delta;
          onEvent('token', { delta });
        },
      });
    } else {
      if (!config.gemini.apiKey) {
        throw new Error('Gemini API key is missing. Set GEMINI_API_KEY in .env');
      }

      const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
      const contents = historyTurns.map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      }));
      contents.push({
        role: 'user',
        parts: [{ text: maskedText }],
      });

      let llmSucceeded = false;

      // Try primary Gemini model
      try {
        console.log(`📡 [Orchestrator] Calling Gemini API (Model: ${PRIMARY_MODEL})...`);
        const stream = await ai.models.generateContentStream({
          model: PRIMARY_MODEL,
          contents,
          config: {
            systemInstruction,
            temperature: 0.2,
          },
        });

        for await (const chunk of stream) {
          const delta = typeof chunk.text === 'function' ? chunk.text() : chunk.text || '';
          if (delta) {
            accumulatedText += delta;
            onEvent('token', { delta });
          }
        }
        llmSucceeded = true;
      } catch (streamErr) {
        console.warn(`⚠️ [Orchestrator Stream] Primary model (${PRIMARY_MODEL}) error: ${streamErr.message}. Trying fallback...`);
      }

      // Try fallback Gemini model if primary failed
      if (!llmSucceeded) {
        try {
          console.log(`📡 [Orchestrator] Retrying Gemini API with fallback model (${FALLBACK_MODEL})...`);
          const fallbackStream = await ai.models.generateContentStream({
            model: FALLBACK_MODEL,
            contents,
            config: {
              systemInstruction,
              temperature: 0.2,
            },
          });

          for await (const chunk of fallbackStream) {
            const delta = typeof chunk.text === 'function' ? chunk.text() : chunk.text || '';
            if (delta) {
              accumulatedText += delta;
              onEvent('token', { delta });
            }
          }
          llmSucceeded = true;
        } catch (fallbackErr) {
          console.warn(`⚠️ [Orchestrator Stream] Fallback model (${FALLBACK_MODEL}) error: ${fallbackErr.message}.`);
        }
      }

      // Zero-Hang Resilient Synthesizer:
      // If external Gemini API is unreachable, offline, rate-limited, or blocked,
      // synthesize directly from retrieved verified policy evidence so user NEVER hangs!
      if (!llmSucceeded || !accumulatedText || accumulatedText.trim().length === 0) {
        if (retrievalResult?.isGrounded && retrievalResult?.chunks?.length > 0) {
          console.log(`ℹ️  [Orchestrator] Synthesizing answer directly from ${retrievalResult.chunks.length} verified evidence chunks.`);
          const topChunk = retrievalResult.chunks[0];
          accumulatedText = `According to ABC Technologies verified policy [1] (§ ${topChunk.sectionTitle}):\n\n${topChunk.text}`;
          if (retrievalResult.chunks.length > 1) {
            accumulatedText += `\n\nAdditionally, [2] (§ ${retrievalResult.chunks[1].sectionTitle}):\n${retrievalResult.chunks[1].text}`;
          }
          onEvent('token', { delta: accumulatedText });
        } else {
          accumulatedText =
            retrievalResult?.fallbackMessage ||
            'No company policy covers this topic. Would you like me to raise an HR or IT ticket for assistance?';
          onEvent('token', { delta: accumulatedText });
        }
      }
    }

    // Package citations
    const packaged = packageResponseWithCitations({
      answerText: accumulatedText,
      chunks: retrievalResult?.chunks || [],
      query: message,
    });

    citationsPayload = {
      hasCitations: packaged.hasCitations,
      citations: packaged.citations,
      activeCitations: packaged.activeCitations,
    };
  }

  // 4. Post-LLM De-Tokenization: Restore raw values from surrogate tokens
  const unmaskedAnswer = hasPII ? unmaskPII(accumulatedText, tokenMap) : accumulatedText;

  // 5. Emit Citation Drawer Event
  onEvent('citation', citationsPayload);

  // 6. Append Session Turns to Redis Sliding Window
  await appendSessionMessage(sessionId, { role: 'user', text: message }, redisClient);
  await appendSessionMessage(sessionId, { role: 'model', text: unmaskedAnswer }, redisClient);

  // 7. Emit Done Event
  onEvent('done', {
    sessionId,
    totalHistoryTurns: historyTurns.length + 2,
    hasCitations: citationsPayload.hasCitations,
    hasActionRequired: Boolean(stagedActionPayload),
    completedAt: new Date().toISOString(),
  });

  // 8. Record copilot interaction in audit log
  if (user?.orgId) {
    recordAuditLog({
      orgId: user.orgId,
      actor: {
        userId: user.userId,
        name: user.name || user.userId,
        role: user.role || 'employee',
      },
      action: detectedTool ? `COPILOT_TURN:${detectedTool.tool}` : 'COPILOT_TURN:RAG_SEARCH',
      entity: {
        type: 'copilot_session',
        id: sessionId,
      },
      changes: {
        after: {
          detectedTool: detectedTool?.tool || 'searchPolicies',
          hasCitations: citationsPayload?.hasCitations || false,
          hasActionRequired: Boolean(stagedActionPayload),
        },
      },
    }).catch(() => {});
  }

  return {
    sessionId,
    answer: unmaskedAnswer,
    hasCitations: citationsPayload.hasCitations,
    stagedAction: stagedActionPayload,
    totalHistoryTurns: historyTurns.length + 2,
  };
}
