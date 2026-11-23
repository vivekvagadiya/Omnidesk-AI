import { GoogleGenAI } from "@google/genai";
import { config } from "../../config/environment.js";
import { getRedisClient } from "../../config/redis.js";
import { retrievePolicyContext } from "../rag/retrieval.service.js";
import { packageResponseWithCitations } from "../rag/citation.service.js";
import { maskPII, unmaskPII } from "./piiMasker.service.js";
import { executeTool } from "../tools/toolRegistry.service.js";
import { recordAuditLog } from "../audit/audit.service.js";

export const PRIMARY_MODEL = "gemini-3.5-flash";
export const FALLBACK_MODEL = "gemini-2.0-flash";

export const SESSION_TTL_SECONDS = 86400; // 24-hour session TTL
export const MAX_SESSION_MESSAGES = 20; // Last 10 turns (user + assistant)
const REQUEST_TIMEOUT_MS = 25000; // 25 seconds timeout for LLM generation

/**
 * In-memory fallback session store for offline/non-production environments.
 *
 * ARCHITECTURAL LIMITATIONS & PRODUCTION CONSTRAINTS:
 * 1. Process-Local / Non-Distributed: State is held in-process within this Node.js instance.
 *    In clustered or horizontally scaled production deployments, subsequent chat turns
 *    routed across different instances will NOT observe this conversation history.
 * 2. Volatile / Ephemeral: Conversation history stored here is immediately lost on process
 *    restart, unhandled exception, or redeployment.
 * 3. Memory Pressure / OOM Risk: Prolonged Redis outages under heavy traffic will accumulate
 *    active session arrays in heap memory despite the periodic 10-minute cleanup timer.
 * 4. Cache-Tier Context Only: Conversation history is ephemeral sliding-window context for
 *    the LLM. MongoDB remains the authoritative durable storage for business entities (tickets,
 *    audit logs, notifications).
 *
 * In production (NODE_ENV === 'production'), Redis is the required distributed storage.
 * If Redis becomes unavailable, the system returns a controlled 503 Service Unavailable error;
 * in-memory fallback is strictly restricted to development and test environments.
 */
const inMemorySessionStore = new Map();

// Periodic cleanup of in-memory fallback sessions
const sessionCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [key, session] of inMemorySessionStore.entries()) {
      if (session.expiresAt <= now) {
        inMemorySessionStore.delete(key);
      }
    }
  },
  10 * 60 * 1000,
);

if (sessionCleanupTimer.unref) {
  sessionCleanupTimer.unref();
}

// In-memory session ownership registry for offline/non-production environments: sessionId -> { orgId, userId, expiresAt }
const inMemorySessionOwners = new Map();

// Periodic cleanup of in-memory session owners
const sessionOwnerCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [key, owner] of inMemorySessionOwners.entries()) {
      if (owner.expiresAt <= now) {
        inMemorySessionOwners.delete(key);
      }
    }
  },
  10 * 60 * 1000,
);

if (sessionOwnerCleanupTimer.unref) {
  sessionOwnerCleanupTimer.unref();
}

/**
 * Custom Error for Session Ownership Violations
 */
export class SessionOwnershipError extends Error {
  constructor(
    message = "Session ownership validation failed: Unauthorized session access.",
  ) {
    super(message);
    this.name = "SessionOwnershipError";
    this.statusCode = 403;
  }
}

/**
 * Atomic Redis Lua script to verify session ownership and delete the owner key and scoped
 * messages atomically. Prevents race conditions and guarantees another user's session cannot be cleared.
 */
const ATOMIC_CLEAR_SESSION_LUA = `
local ownerRaw = redis.call("get", KEYS[1])
if not ownerRaw then
  if KEYS[2] and KEYS[2] ~= "" then
    redis.call("del", KEYS[2])
  end
  return 1
end

local ok, owner = pcall(cjson.decode, ownerRaw)
if ok and owner and owner.orgId == ARGV[1] and owner.userId == ARGV[2] then
  redis.call("del", KEYS[1])
  if KEYS[2] and KEYS[2] ~= "" then
    redis.call("del", KEYS[2])
  end
  return 1
else
  return -1
end
`;

/**
 * Build the canonical scoped Redis key for session message history
 * Scoped by orgId + userId + sessionId:
 * `session:${orgId}:${userId}:${sessionId}:messages`
 *
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.userId
 * @param {string} params.sessionId
 * @returns {string}
 */
export function buildSessionKey({ orgId, userId, sessionId }) {
  if (!sessionId) return null;
  const cleanSessionId = String(sessionId).trim();
  if (orgId && userId) {
    return `session:${String(orgId).trim()}:${String(userId).trim()}:${cleanSessionId}:messages`;
  }
  if (config.nodeEnv === "production") {
    throw new SessionOwnershipError(
      "Cannot build unscoped session key: orgId and userId are strictly required in production.",
    );
  }
  return `session:${cleanSessionId}:messages`;
}

/**
 * Resolve the canonical scoped Redis key for a session target.
 *
 * @param {string|Object} target Session ID string or { sessionId, orgId, userId } object
 * @param {Object} [user] User object { orgId, userId }
 * @param {Object} [client] Redis client
 * @returns {Promise<string>} Scoped key
 */
export async function resolveSessionKey(target, user = null, client = null) {
  if (!target) return null;

  let sessionId = null;
  let orgId = null;
  let userId = null;

  if (typeof target === "object" && target !== null) {
    sessionId = target.sessionId || target.id;
    orgId = target.orgId || target.user?.orgId || user?.orgId;
    userId = target.userId || target.user?.userId || user?.userId;
  } else {
    sessionId = String(target).trim();
    orgId = user?.orgId;
    userId = user?.userId;
  }

  if (orgId && userId && sessionId) {
    return buildSessionKey({ orgId, userId, sessionId });
  }

  // In production, strictly require authenticated identity (orgId and userId).
  // The Redis ownership registry must NEVER replace authenticated identity in production.
  if (config.nodeEnv === "production") {
    throw new SessionOwnershipError(
      `Cannot resolve session key for '${sessionId || "unknown"}': Authenticated user context with orgId and userId is strictly required in production.`,
    );
  }

  // Non-production fallback only (dev / test backward compatibility):
  const cleanSessionId = String(sessionId || "").trim();

  // Check in-memory ownership registry (non-prod)
  const memOwner = inMemorySessionOwners.get(cleanSessionId);
  if (memOwner?.orgId && memOwner?.userId) {
    return buildSessionKey({
      orgId: memOwner.orgId,
      userId: memOwner.userId,
      sessionId: cleanSessionId,
    });
  }

  // Check Redis ownership registry (non-prod)
  if (client && (client.isReady || client.isOpen)) {
    try {
      const rawOwner = await client.get(`session:owner:${cleanSessionId}`);
      if (rawOwner) {
        const owner = JSON.parse(rawOwner);
        if (owner.orgId && owner.userId) {
          return buildSessionKey({
            orgId: owner.orgId,
            userId: owner.userId,
            sessionId: cleanSessionId,
          });
        }
      }
    } catch {
      // Fall through to dev unscoped key
    }
  }

  return `session:${cleanSessionId}:messages`;
}

/**
 * Validate that a sessionId is owned by the authenticated user and organization.
 *
 * Scopes session ownership in Redis under `session:owner:${sessionId}`.
 * - If session is already owned by another user or tenant, throws SessionOwnershipError (403).
 * - If session is new, registers ownership to the authenticated user and tenant with SESSION_TTL_SECONDS.
 * - If session is already owned by the authenticated user, refreshes the ownership TTL.
 *
 * @param {Object} params
 * @param {string} params.sessionId Target session ID
 * @param {Object} params.user Authenticated user object ({ orgId, userId })
 * @param {Object} [params.client] Redis client instance
 * @returns {Promise<boolean>} True if ownership is valid and active
 */
export async function validateSessionOwnership({
  sessionId,
  user,
  client = getRedisClient(),
}) {
  if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
    throw new SessionOwnershipError(
      "sessionId is required for ownership validation.",
    );
  }
  if (!user || !user.orgId || !user.userId) {
    throw new SessionOwnershipError(
      "Authenticated user with orgId and userId is required.",
    );
  }

  const cleanSessionId = sessionId.trim();
  const ownerKey = `session:owner:${cleanSessionId}`;

  // 1. Check Redis if available
  if (client && (client.isReady || client.isOpen)) {
    try {
      const rawOwner = await client.get(ownerKey);
      if (rawOwner) {
        const owner = JSON.parse(rawOwner);
        if (owner.orgId !== user.orgId || owner.userId !== user.userId) {
          console.warn(
            `🚨 [Security] Session ownership breach: User '${user.userId}' (Org: '${user.orgId}') attempted to access session '${cleanSessionId}' owned by '${owner.userId}' (Org: '${owner.orgId}').`,
          );
          throw new SessionOwnershipError(
            `Forbidden: Session '${cleanSessionId}' does not belong to the authenticated user.`,
          );
        }
        // Refresh TTL on active access
        await client.expire(ownerKey, SESSION_TTL_SECONDS);
        return true;
      }

      // New session: bind ownership atomically with NX
      const ownerPayload = JSON.stringify({
        orgId: user.orgId,
        userId: user.userId,
        createdAt: new Date().toISOString(),
      });

      const setSuccess = await client.set(ownerKey, ownerPayload, {
        NX: true,
        EX: SESSION_TTL_SECONDS,
      });

      if (!setSuccess) {
        // Handle concurrent registration
        const currentRaw = await client.get(ownerKey);
        if (currentRaw) {
          const currentOwner = JSON.parse(currentRaw);
          if (
            currentOwner.orgId !== user.orgId ||
            currentOwner.userId !== user.userId
          ) {
            throw new SessionOwnershipError(
              `Forbidden: Session '${cleanSessionId}' does not belong to the authenticated user.`,
            );
          }
        }
      }
      return true;
    } catch (err) {
      if (err instanceof SessionOwnershipError) throw err;
      if (config.nodeEnv === "production") {
        console.error(
          `🚨 [Orchestrator] Redis session ownership error (${cleanSessionId}): ${err.message}`,
        );
        const serviceErr = new Error(
          `Service Unavailable: Redis session ownership error - ${err.message}`,
        );
        serviceErr.statusCode = 503;
        throw serviceErr;
      }
    }
  } else if (config.nodeEnv === "production") {
    const serviceErr = new Error("Service Unavailable: Redis is unavailable.");
    serviceErr.statusCode = 503;
    throw serviceErr;
  }

  // 2. Non-production / offline in-memory fallback
  const memOwner = inMemorySessionOwners.get(cleanSessionId);
  if (memOwner && memOwner.expiresAt > Date.now()) {
    if (memOwner.orgId !== user.orgId || memOwner.userId !== user.userId) {
      console.warn(
        `🚨 [Security] In-memory session ownership breach: User '${user.userId}' (Org: '${user.orgId}') attempted to access session '${cleanSessionId}' owned by '${memOwner.userId}' (Org: '${memOwner.orgId}').`,
      );
      throw new SessionOwnershipError(
        `Forbidden: Session '${cleanSessionId}' does not belong to the authenticated user.`,
      );
    }
    memOwner.expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
    return true;
  }

  inMemorySessionOwners.set(cleanSessionId, {
    orgId: user.orgId,
    userId: user.userId,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  });

  return true;
}

/**
 * Retrieve sliding-window conversation turns from Redis (or in-memory non-prod fallback)
 *
 * @param {string|Object} sessionTarget Session ID or { sessionId, orgId, userId }
 * @param {Object} [client]
 * @param {Object} [user]
 * @returns {Promise<Array<{ role: string, text: string, timestamp: string }>>}
 */
export async function getSessionHistory(
  sessionTarget,
  client = getRedisClient(),
  user = null,
) {
  if (!sessionTarget) return [];

  const key = await resolveSessionKey(sessionTarget, user, client);
  if (!key) return [];

  if (client && client.isOpen) {
    try {
      const rawTurns = await client.lRange(key, -MAX_SESSION_MESSAGES, -1);
      return rawTurns.map((turnStr) => JSON.parse(turnStr));
    } catch (err) {
      if (config.nodeEnv === "production") {
        console.error(
          `🚨 [Orchestrator] Redis session read failed in production (${key}): ${err.message}`,
        );
        const serviceErr = new Error(
          `Service Unavailable: Redis session read error - ${err.message}`,
        );
        serviceErr.statusCode = 503;
        throw serviceErr;
      } else {
        console.warn(
          `⚠️ [Orchestrator] Redis session read error: ${err.message}. Using memory store.`,
        );
      }
    }
  } else if (config.nodeEnv === "production") {
    console.error(
      `🚨 [Orchestrator] Redis unavailable in production for session read (${key}).`,
    );
    const serviceErr = new Error(
      "Service Unavailable: Redis session store is unavailable.",
    );
    serviceErr.statusCode = 503;
    throw serviceErr;
  }

  // Non-production fallback (offline sandbox / unit tests)
  const record = inMemorySessionStore.get(key);
  if (!record || record.expiresAt <= Date.now()) {
    return [];
  }
  return record.messages || [];
}

/**
 * Append a conversation turn to the Redis session sliding window
 *
 * @param {string|Object} sessionTarget
 * @param {Object} message { role: 'user'|'model', text: string }
 * @param {Object} [client]
 * @param {Object} [user]
 */
export async function appendSessionMessage(
  sessionTarget,
  message,
  client = getRedisClient(),
  user = null,
) {
  if (!sessionTarget || !message) return;

  const key = await resolveSessionKey(sessionTarget, user, client);
  if (!key) return;

  const enrichedMessage = {
    ...message,
    timestamp: message.timestamp || new Date().toISOString(),
  };

  if (client && client.isOpen) {
    try {
      await client.rPush(key, JSON.stringify(enrichedMessage));
      await client.lTrim(key, -MAX_SESSION_MESSAGES, -1);
      await client.expire(key, SESSION_TTL_SECONDS);
      return;
    } catch (err) {
      if (config.nodeEnv === "production") {
        console.error(
          `🚨 [Orchestrator] Redis session write failed in production (${key}): ${err.message}`,
        );
        const serviceErr = new Error(
          `Service Unavailable: Redis session write error - ${err.message}`,
        );
        serviceErr.statusCode = 503;
        throw serviceErr;
      } else {
        console.warn(
          `⚠️ [Orchestrator] Redis session write error: ${err.message}. Saving to memory store.`,
        );
      }
    }
  } else if (config.nodeEnv === "production") {
    console.error(
      `🚨 [Orchestrator] Redis unavailable in production for session write (${key}).`,
    );
    const serviceErr = new Error(
      "Service Unavailable: Redis session store is unavailable.",
    );
    serviceErr.statusCode = 503;
    throw serviceErr;
  }

  // Non-production fallback
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
 * Clear conversation history for a session with atomic ownership verification.
 * Validates authenticated orgId and userId, verifies ownership in Redis atomically,
 * and expunges both the session owner record and scoped message list.
 * Prevents an unverified caller from clearing another user's session.
 *
 * @param {string|Object} sessionTarget Session ID string or { sessionId, orgId, userId }
 * @param {Object} [client] Redis client
 * @param {Object} [user] Authenticated user object { orgId, userId }
 */
export async function clearSessionHistory(
  sessionTarget,
  client = getRedisClient(),
  user = null,
) {
  if (!sessionTarget) return;

  const rawSessionId =
    typeof sessionTarget === "object" && sessionTarget !== null
      ? sessionTarget.sessionId || sessionTarget.id
      : sessionTarget;

  if (!rawSessionId || typeof rawSessionId !== "string") return;
  const cleanSessionId = rawSessionId.trim();

  const orgId =
    typeof sessionTarget === "object" && sessionTarget !== null
      ? sessionTarget.orgId || sessionTarget.user?.orgId || user?.orgId
      : user?.orgId;
  const userId =
    typeof sessionTarget === "object" && sessionTarget !== null
      ? sessionTarget.userId || sessionTarget.user?.userId || user?.userId
      : user?.userId;

  // In production, authenticated orgId and userId are strictly required
  if (!orgId || !userId) {
    if (config.nodeEnv === "production") {
      throw new SessionOwnershipError(
        "Cannot clear session history: orgId and userId are strictly required in production.",
      );
    }
    // Dev/test backward compatibility: delete unscoped test key without touching ownership registry
    const legacyKey = `session:${cleanSessionId}:messages`;
    if (client && (client.isReady || client.isOpen)) {
      try {
        await client.del(legacyKey);
      } catch (err) {
        console.warn(
          `⚠️ [Orchestrator] Redis legacy session delete error: ${err.message}`,
        );
      }
    }
    inMemorySessionStore.delete(legacyKey);
    return;
  }

  const cleanOrgId = String(orgId).trim();
  const cleanUserId = String(userId).trim();
  const ownerKey = `session:owner:${cleanSessionId}`;
  const historyKey = buildSessionKey({
    orgId: cleanOrgId,
    userId: cleanUserId,
    sessionId: cleanSessionId,
  });

  // 1. Primary path: Atomic Lua check-and-delete in Redis
  if (client && (client.isReady || client.isOpen)) {
    try {
      const result = await client.eval(ATOMIC_CLEAR_SESSION_LUA, {
        keys: [ownerKey, historyKey],
        arguments: [cleanOrgId, cleanUserId],
      });

      if (result === -1) {
        throw new SessionOwnershipError(
          `Forbidden: Session '${cleanSessionId}' does not belong to the authenticated user.`,
        );
      }
    } catch (err) {
      if (err instanceof SessionOwnershipError) throw err;
      if (config.nodeEnv === "production") {
        const serviceErr = new Error(
          `Service Unavailable: Redis session delete error - ${err.message}`,
        );
        serviceErr.statusCode = 503;
        throw serviceErr;
      }
      console.warn(
        `⚠️ [Orchestrator] Redis session delete error: ${err.message}`,
      );
    }
  } else if (config.nodeEnv === "production") {
    const serviceErr = new Error(
      "Service Unavailable: Redis session store is unavailable.",
    );
    serviceErr.statusCode = 503;
    throw serviceErr;
  }

  // 2. In-memory cleanup with verified ownership (dev/test environments)
  const memOwner = inMemorySessionOwners.get(cleanSessionId);
  if (memOwner) {
    if (memOwner.orgId !== cleanOrgId || memOwner.userId !== cleanUserId) {
      throw new SessionOwnershipError(
        `Forbidden: Session '${cleanSessionId}' does not belong to the authenticated user.`,
      );
    }
    inMemorySessionOwners.delete(cleanSessionId);
  }
  if (historyKey) inMemorySessionStore.delete(historyKey);
}

/**
 * Assemble the Enterprise System Instructions enforcing Role Boundaries and Evidence Citations
 *
 * @param {Object} params
 * @param {Object} params.user Current authenticated employee
 * @param {string} [params.evidenceContext] RAG evidence context block
 * @returns {string} System instruction string
 */
export function buildSystemInstructions({ user, evidenceContext = "" }) {
  const userName = user?.name || "Employee";
  const userId = user?.userId || "unknown";
  const userRole = user?.role || "employee";
  const orgId = user?.orgId || "org_abc";
  const department = user?.department || "General";

  const roleRules = {
    employee:
      "- Role Privileges: Self-service operations only. You can view your own leave balance, active tickets, apply for leaves, and request hardware refreshes.\n- Role Boundaries: You CANNOT approve leave requests or inspect other employees' sensitive records.",
    manager:
      "- Role Privileges: Team management. You supervise your direct reports, can inspect team leave requests, and approve/reject team actions.\n- Role Boundaries: You cannot alter global organization configuration.",
    hr_admin:
      "- Role Privileges: Human resources administration. You can upload and inspect all HR policies, audit company-wide leave balances, and review HR support tickets.",
    it_admin:
      "- Role Privileges: IT systems and hardware inventory administration. You can upload and inspect IT policies, review hardware asset allocations, and process hardware upgrades.",
    org_admin:
      "- Role Privileges: Complete organization oversight across HR and IT departments.",
    super_admin:
      "- Role Privileges: Platform root owner with diagnostic and tenant provisioning authority.",
  };

  const selectedRoleGuidance = roleRules[userRole] || roleRules.employee;

  return [
    "=== OMNIDESK AI: ENTERPRISE IT & HR OPERATIONS COPILOT ===",
    "You are OmniDesk AI, the autonomous IT and HR operations copilot for ABC Technologies.",
    "",
    "--- CURRENT USER CONTEXT ---",
    `Name        : ${userName}`,
    `Employee ID : ${userId}`,
    `Tenant Org  : ${orgId}`,
    `Department  : ${department}`,
    `User Role   : ${userRole}`,
    "",
    "--- ROLE-BASED ACCESS CONTROL (RBAC) GOVERNANCE ---",
    selectedRoleGuidance,
    "",
    "--- ZERO-HALLUCINATION & CITATION RULES ---",
    "1. When verified policy excerpts are provided below, answer using ONLY that evidence.",
    "2. You MUST cite references using in-text numbered badges like [1], [2], corresponding to the policy sources.",
    '3. If no policy evidence is provided or the topic is not covered, state plainly: "No company policy covers this topic. Would you like me to raise an HR or IT ticket for assistance?"',
    "4. Never fabricate policies, entitlement quotas, or corporate rules.",
    "",
    evidenceContext ||
      "No verified organization policies attached for this query.",
  ].join("\n");
}

/**
 * Format multi-turn conversation history into Gemini API contents structure
 *
 * @param {Array<{ role: string, text: string }>} historyTurns
 * @param {string} currentMessage Masked user query
 * @returns {Array<{ role: string, parts: Array<{ text: string }> }>}
 */
export function formatGeminiContents(historyTurns = [], currentMessage = "") {
  const contents = (historyTurns || []).map((turn) => ({
    role: turn.role === "model" || turn.role === "assistant" ? "model" : "user",
    parts: [{ text: turn.text || "" }],
  }));

  if (currentMessage) {
    contents.push({
      role: "user",
      parts: [{ text: currentMessage }],
    });
  }

  return contents;
}

/**
 * Detect whether an error qualifies for attempting a fallback model
 * (Rate limits, quota limits, timeouts, and transient service unavailabilities).
 * Non-transient errors like bad auth or invalid request formats fail immediately.
 *
 * @param {Error} err
 * @returns {boolean}
 */
export function isTransientOrRateLimitError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  const status = err.status || err.statusCode || err.code;

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("resource_exhausted") ||
    msg.includes("timeout") ||
    msg.includes("unavailable") ||
    msg.includes("econnreset")
  );
}

/**
 * Extract real provider token usage metadata when supplied
 *
 * @param {Object} rawUsage
 * @returns {Object|null}
 */
export function extractUsageMetadata(rawUsage) {
  if (!rawUsage) return null;
  return {
    promptTokens: rawUsage.promptTokenCount || 0,
    completionTokens: rawUsage.candidatesTokenCount || 0,
    totalTokens: rawUsage.totalTokenCount || 0,
  };
}

/**
 * Call Gemini API with timeout, transient fallback model retry, and real usage collection
 *
 * @param {Object} params
 * @param {Array} params.contents Formatted Gemini contents array
 * @param {string} params.systemInstruction System instruction string
 * @param {boolean} [params.stream=false] Whether to stream tokens
 * @param {Function} [params.onToken] Token callback for streaming
 * @param {number} [params.timeoutMs=REQUEST_TIMEOUT_MS] Request timeout in ms
 * @returns {Promise<{ text: string, usageMetadata: Object|null }>}
 */
async function callGemini({
  contents,
  systemInstruction,
  stream = false,
  onToken = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!config.gemini?.apiKey) {
    throw new Error("Gemini API key is missing. Set GEMINI_API_KEY in .env");
  }

  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const modelConfig = {
    systemInstruction,
    temperature: 0.2, // Low temperature for high factual accuracy
  };

  const executeModel = async (modelName) => {
    let accumulated = "";
    let rawUsage = null;

    if (stream) {
      const responseStream = await Promise.race([
        ai.models.generateContentStream({
          model: modelName,
          contents,
          config: modelConfig,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Gemini streaming request timed out after ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          ),
        ),
      ]);

      for await (const chunk of responseStream) {
        const delta =
          typeof chunk.text === "function" ? chunk.text() : chunk.text || "";
        if (delta) {
          accumulated += delta;
          if (typeof onToken === "function") {
            onToken(delta);
          }
        }
        if (chunk.usageMetadata) {
          rawUsage = chunk.usageMetadata;
        }
      }
    } else {
      const response = await Promise.race([
        ai.models.generateContent({
          model: modelName,
          contents,
          config: modelConfig,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`Gemini request timed out after ${timeoutMs}ms`),
              ),
            timeoutMs,
          ),
        ),
      ]);

      accumulated =
        response.text?.trim() ||
        response.candidates?.[0]?.content?.parts?.[0]?.text ||
        "";
      rawUsage = response.usageMetadata;
    }

    return {
      text: accumulated,
      usageMetadata: extractUsageMetadata(rawUsage),
    };
  };

  try {
    return await executeModel(PRIMARY_MODEL);
  } catch (primaryErr) {
    if (isTransientOrRateLimitError(primaryErr)) {
      console.warn(
        `⚠️ [Orchestrator] Primary model (${PRIMARY_MODEL}) transient error: ${primaryErr.message}. Attempting fallback (${FALLBACK_MODEL})...`,
      );
      try {
        return await executeModel(FALLBACK_MODEL);
      } catch (fallbackErr) {
        console.error(
          `❌ [Orchestrator] Fallback model (${FALLBACK_MODEL}) also failed: ${fallbackErr.message}`,
        );
        throw fallbackErr;
      }
    }
    throw primaryErr;
  }
}

/**
 * Detect if user query targets one of the registered operational tools
 *
 * @param {string} message
 * @returns {{ tool: string, args: Object } | null}
 */
export function detectToolIntent(message) {
  if (!message || typeof message !== "string") return null;
  const text = message.toLowerCase().trim();

  // 1. Leave Balance Inquiry
  if (
    /leave\s+balance|how\s+many\s+(?:casual|sick|maternity)?\s*(?:days|leaves)\s+(?:do\s+i\s+have|remaining|left)/i.test(
      text,
    )
  ) {
    return { tool: "getLeaveBalance", args: {} };
  }

  // 2. Tickets Inquiry
  if (/(?:show|view|get|list|my)\s+(?:open\s+)?tickets/i.test(text)) {
    const status = text.includes("open") ? "OPEN" : "ALL";
    return { tool: "getMyTickets", args: { status } };
  }

  // 3. Apply Leave (Consequential / HITL)
  const leaveMatch = text.match(
    /apply\s+(?:for\s+)?(\d+)\s+days?\s+(?:of\s+)?(casual|sick|maternity)\s+(?:leave\s+)?(?:starting|from)?\s*(\d{4}-\d{2}-\d{2})/i,
  );
  if (leaveMatch) {
    return {
      tool: "applyLeave",
      args: {
        days: parseInt(leaveMatch[1], 10),
        leaveType: leaveMatch[2].toLowerCase(),
        startDate: leaveMatch[3],
        reason: "Requested via Copilot Chat",
      },
    };
  }

  // 4. Request Hardware Upgrade (Consequential / HITL)
  if (
    /request\s+(?:hardware|upgrade|new\s+laptop|new\s+monitor)/i.test(text) ||
    /upgrade\s+my\s+(?:laptop|hardware|monitor|workstation)/i.test(text)
  ) {
    const assetType = text.includes("monitor") ? "MONITOR" : "LAPTOP";
    let model = "High-Performance Workstation";
    if (text.includes("macbook")) model = "MacBook Pro 16-inch M3 Max";
    else if (text.includes("dell") || text.includes("xps"))
      model = "Dell XPS 15 9530";
    else if (text.includes("thinkpad")) model = "ThinkPad T14 Gen 4";

    return {
      tool: "requestHardwareUpgrade",
      args: {
        assetType,
        preferredModel: model,
        reason: "Requested via Copilot Chat",
        urgency: "MEDIUM",
      },
    };
  }

  return null;
}

/**
 * Execute an operational tool and synthesize its user-facing text
 *
 * @param {Object} params
 * @param {Object} params.detectedTool Tool intent { tool, args }
 * @param {Object} params.user Authenticated user
 * @param {Object} [params.redisClient]
 * @param {Function} [params.customEmbeddingProvider]
 * @param {Object} [params.qdrantClient]
 * @returns {Promise<{ text: string, stagedAction: Object|null }>}
 */
async function executeToolIntent({
  detectedTool,
  user,
  redisClient,
  customEmbeddingProvider,
  qdrantClient,
}) {
  let text = "";
  let stagedAction = null;

  let toolResult;
  try {
    toolResult = await executeTool(detectedTool.tool, detectedTool.args || {}, {
      user,
      redisClient,
      embeddingProvider: customEmbeddingProvider,
      qdrantClient,
    });
  } catch (err) {
    return {
      text: err.message || "Unable to execute requested tool action.",
      stagedAction: null,
    };
  }

  if (toolResult.isConsequential && toolResult.requiresConfirmation) {
    stagedAction = {
      actionId: toolResult.actionId,
      type: toolResult.actionType,
      card: toolResult.card,
      summary: toolResult.summary,
    };
    text =
      toolResult.message ||
      `I have staged your ${toolResult.actionType} request. Please confirm or decline using the approval card below.`;
  } else if (detectedTool.tool === "getLeaveBalance") {
    text = `Here are your current leave balances, ${toolResult.name || user.name || "there"}:\n- Casual Leave: ${toolResult.leaveBalances.casual} days\n- Sick Leave: ${toolResult.leaveBalances.sick} days\n- Maternity Leave: ${toolResult.leaveBalances.maternity} days`;
  } else if (detectedTool.tool === "getMyTickets") {
    if (!toolResult.tickets || toolResult.tickets.length === 0) {
      text = "You currently have no open support tickets on record.";
    } else {
      const ticketLines = toolResult.tickets
        .slice(0, 5)
        .map(
          (t) =>
            `- [${t.ticketId}] (${t.status}) ${t.title} [${t.priority} Priority]`,
        )
        .join("\n");
      text = `Here are your recent tickets:\n${ticketLines}`;
    }
  } else if (detectedTool.tool === "createTicket") {
    text = `Support Ticket **${toolResult.ticket.ticketId}** has been opened successfully under category **${toolResult.ticket.category}** with **${toolResult.ticket.priority}** priority.`;
  } else {
    text =
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
  }

  return { text, stagedAction };
}

/**
 * Shared post-processing for both streaming and non-streaming copilot turns:
 * Unmasks PII, packages citations, updates session history, and logs audit events.
 *
 * @param {Object} params
 * @returns {Promise<Object>} Final sanitized turn result
 */
async function finalizeTurn({
  sessionId,
  user,
  rawMessage,
  rawAnswerText,
  tokenMap,
  hasPII,
  chunks = [],
  historyTurns = [],
  detectedTool = null,
  stagedAction = null,
  usageMetadata = null,
  isGrounded = true,
  suggestedAction = null,
  redisClient = getRedisClient(),
}) {
  // 1. Post-LLM De-Tokenization: Restore sensitive surrogate tokens
  const unmaskedAnswer = hasPII
    ? unmaskPII(rawAnswerText, tokenMap)
    : rawAnswerText;

  // 2. Package Citations
  const packaged = packageResponseWithCitations({
    answerText: unmaskedAnswer,
    chunks: chunks || [],
    query: rawMessage,
  });

  // 3. Append Turns to Redis Session Memory (scoped by orgId + userId + sessionId)
  const sessionTarget = {
    sessionId,
    orgId: user?.orgId,
    userId: user?.userId,
  };

  await appendSessionMessage(
    sessionTarget,
    { role: "user", text: rawMessage },
    redisClient,
    user,
  );
  await appendSessionMessage(
    sessionTarget,
    { role: "model", text: unmaskedAnswer },
    redisClient,
    user,
  );

  // 4. Record Audit Log
  if (user?.orgId) {
    recordAuditLog({
      orgId: user.orgId,
      actor: {
        userId: user.userId,
        name: user.name || user.userId,
        role: user.role || "employee",
      },
      action: detectedTool
        ? `COPILOT_TURN:${detectedTool.tool}`
        : "COPILOT_TURN:RAG_SEARCH",
      entity: {
        type: "copilot_session",
        id: sessionId,
      },
      changes: {
        after: {
          detectedTool: detectedTool?.tool || "searchPolicies",
          hasCitations: packaged.hasCitations,
          hasActionRequired: Boolean(stagedAction),
        },
      },
    }).catch((err) => {
      console.error(
        `🚨 [AuditLog] Failed to record audit log for copilot turn (session: ${sessionId}): ${err.message}`,
      );
    });
  }

  return {
    sessionId,
    answer: unmaskedAnswer,
    isGrounded,
    hasCitations: packaged.hasCitations,
    hasPII,
    piiMasked: hasPII,
    citations: packaged.citations,
    activeCitations: packaged.activeCitations,
    suggestedAction: stagedAction ? null : suggestedAction,
    stagedAction: stagedAction || null,
    totalHistoryTurns: historyTurns.length + 2,
    usage: usageMetadata || null,
  };
}

/**
 * Execute an End-to-End Non-Streaming Copilot Turn
 *
 * @param {Object} params
 * @param {string} params.sessionId Unique chat session ID
 * @param {string} params.message Current user message
 * @param {Object} params.user Authenticated employee user object
 * @param {Function} [params.customLlmProvider] Optional mock LLM for testing
 * @param {Function} [params.customEmbeddingProvider] Optional custom embedding provider
 * @param {Object} [params.qdrantClient] Optional custom Qdrant client
 * @param {Object} [params.redisClient] Optional custom Redis client
 * @returns {Promise<Object>} Formatted response with citations and session metadata
 */
export async function runCopilotTurn({
  sessionId,
  message,
  user,
  customLlmProvider = null,
  customEmbeddingProvider = null,
  qdrantClient = null,
  redisClient = getRedisClient(),
}) {
  if (!sessionId) {
    throw new Error("sessionId is required for copilot conversation.");
  }
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    throw new Error("User message is required.");
  }
  if (!user || !user.orgId || !user.userId) {
    throw new Error(
      "Authenticated user context with orgId and userId is required.",
    );
  }

  // 1. Validate Session Ownership & Isolation
  await validateSessionOwnership({ sessionId, user, client: redisClient });

  // 2. Pre-LLM PII Masking
  const { maskedText, tokenMap, hasPII } = maskPII(message);

  // 3. Load Multi-Turn History (scoped by orgId + userId + sessionId)
  const sessionTarget = { sessionId, orgId: user.orgId, userId: user.userId };
  const historyTurns = await getSessionHistory(
    sessionTarget,
    redisClient,
    user,
  );

  // 3. Tool Intent Evaluation
  const detectedTool = detectToolIntent(message);
  if (detectedTool && detectedTool.tool !== "searchPolicies") {
    const { text, stagedAction } = await executeToolIntent({
      detectedTool,
      user,
      redisClient,
      customEmbeddingProvider,
      qdrantClient,
    });

    return await finalizeTurn({
      sessionId,
      user,
      rawMessage: message,
      rawAnswerText: text,
      tokenMap,
      hasPII,
      chunks: [],
      historyTurns,
      detectedTool,
      stagedAction,
      isGrounded: true,
      redisClient,
    });
  }

  // 4. Evidence-Based RAG Retrieval
  const retrievalResult = await retrievePolicyContext({
    query: maskedText,
    user,
    embeddingProvider: customEmbeddingProvider,
    qdrantClient,
  });

  // 5. Assemble System Prompt
  const systemInstruction = buildSystemInstructions({
    user,
    evidenceContext: retrievalResult.contextBlock,
  });

  let responseText = "";
  let usageMetadata = null;

  if (typeof customLlmProvider === "function") {
    responseText = await customLlmProvider({
      message: maskedText,
      history: historyTurns,
      systemInstruction,
      retrievalResult,
      tokenMap,
    });
  } else {
    const contents = formatGeminiContents(historyTurns, maskedText);
    const geminiResult = await callGemini({
      contents,
      systemInstruction,
      stream: false,
    });
    responseText = geminiResult.text;
    usageMetadata = geminiResult.usageMetadata;
  }

  // Ungrounded fallback check
  if (
    !retrievalResult.isGrounded &&
    (!responseText || responseText.length < 5)
  ) {
    responseText = retrievalResult.fallbackMessage;
  }

  return await finalizeTurn({
    sessionId,
    user,
    rawMessage: message,
    rawAnswerText: responseText,
    tokenMap,
    hasPII,
    chunks: retrievalResult.chunks,
    historyTurns,
    detectedTool,
    usageMetadata,
    isGrounded: retrievalResult.isGrounded,
    suggestedAction: retrievalResult.suggestedAction || null,
    redisClient,
  });
}

/**
 * Execute an End-to-End Streaming Copilot Turn using SSE
 *
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
    throw new Error("sessionId is required for copilot conversation.");
  }
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    throw new Error("User message is required.");
  }
  if (!user || !user.orgId || !user.userId) {
    throw new Error(
      "Authenticated user context with orgId and userId is required.",
    );
  }
  if (typeof onEvent !== "function") {
    throw new Error("onEvent callback function is required for SSE streaming.");
  }

  // 1. Validate Session Ownership & Isolation
  await validateSessionOwnership({ sessionId, user, client: redisClient });

  // 2. Pre-LLM PII Masking
  const { maskedText, tokenMap, hasPII } = maskPII(message);

  // 3. Load Multi-Turn History (scoped by orgId + userId + sessionId)
  const sessionTarget = { sessionId, orgId: user.orgId, userId: user.userId };
  const historyTurns = await getSessionHistory(
    sessionTarget,
    redisClient,
    user,
  );

  let accumulatedText = "";
  let stagedActionPayload = null;
  let usageMetadata = null;
  let chunks = [];
  let isGrounded = true;
  let suggestedAction = null;

  // 3. Tool Intent Evaluation
  const detectedTool = explicitToolCall || detectToolIntent(message);

  if (detectedTool && detectedTool.tool !== "searchPolicies") {
    onEvent("tool_call", {
      tool: detectedTool.tool,
      status: `Executing: ${detectedTool.tool}...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const { text, stagedAction } = await executeToolIntent({
        detectedTool,
        user,
        redisClient,
        customEmbeddingProvider,
        qdrantClient,
      });

      stagedActionPayload = stagedAction;
      accumulatedText = text;

      if (stagedActionPayload) {
        onEvent("action_required", stagedActionPayload);
      }

      onEvent("token", { delta: accumulatedText });
    } catch (toolErr) {
      accumulatedText = `⚠️ Error executing ${detectedTool.tool}: ${toolErr.message}`;
      onEvent("token", { delta: accumulatedText });
    }
  } else {
    // 4. Semantic Policy Search (Evidence-Based RAG)
    onEvent("tool_call", {
      tool: "searchPolicies",
      status: "Searching ABC Tech policy knowledge base in Qdrant...",
      timestamp: new Date().toISOString(),
    });

    const retrievalResult = await retrievePolicyContext({
      query: (detectedTool && detectedTool.args?.query) || maskedText,
      user,
      embeddingProvider: customEmbeddingProvider,
      qdrantClient,
    });

    chunks = retrievalResult?.chunks || [];
    isGrounded = retrievalResult?.isGrounded ?? false;
    suggestedAction = retrievalResult?.suggestedAction || null;

    const systemInstruction = buildSystemInstructions({
      user,
      evidenceContext: retrievalResult?.contextBlock || "",
    });

    // 5. Generate stream from LLM
    if (typeof customLlmStreamProvider === "function") {
      await customLlmStreamProvider({
        message: maskedText,
        history: historyTurns,
        systemInstruction,
        retrievalResult,
        tokenMap,
        emitToken: (delta) => {
          accumulatedText += delta;
          onEvent("token", { delta });
        },
      });
    } else {
      const contents = formatGeminiContents(historyTurns, maskedText);
      console.log(
        `📡 [Orchestrator] Invoking Gemini API (Primary: ${PRIMARY_MODEL})...`,
      );

      const geminiResult = await callGemini({
        contents,
        systemInstruction,
        stream: true,
        onToken: (delta) => {
          accumulatedText += delta;
          onEvent("token", { delta });
        },
      });

      usageMetadata = geminiResult.usageMetadata;
    }
  }

  // 6. Finalize Turn
  const finalSummary = await finalizeTurn({
    sessionId,
    user,
    rawMessage: message,
    rawAnswerText: accumulatedText,
    tokenMap,
    hasPII,
    chunks,
    historyTurns,
    detectedTool,
    stagedAction: stagedActionPayload,
    usageMetadata,
    isGrounded,
    suggestedAction,
    redisClient,
  });

  // 7. Emit Citation Drawer Event
  onEvent("citation", {
    hasCitations: finalSummary.hasCitations,
    citations: finalSummary.citations,
    activeCitations: finalSummary.activeCitations,
  });

  // 8. Emit Done Event
  onEvent("done", {
    sessionId,
    totalHistoryTurns: finalSummary.totalHistoryTurns,
    hasCitations: finalSummary.hasCitations,
    hasActionRequired: Boolean(stagedActionPayload),
    completedAt: new Date().toISOString(),
    usage: usageMetadata || undefined,
  });

  return finalSummary;
}
