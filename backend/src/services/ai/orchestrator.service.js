import crypto from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { config } from "../../config/environment.js";
import { getRedisClient } from "../../config/redis.js";
import { retrievePolicyContext } from "../rag/retrieval.service.js";
import { packageResponseWithCitations } from "../rag/citation.service.js";
import { maskPII, unmaskPII } from "./piiMasker.service.js";
import {
  executeTool,
  TOOL_DEFINITIONS,
  SAFE_TOOLS,
  MUTATION_TOOLS,
  CONSEQUENTIAL_TOOLS,
} from "../tools/toolRegistry.service.js";
import { recordAuditLog } from "../audit/audit.service.js";

export const PRIMARY_MODEL = config.gemini?.primaryModel || "gemini-3.8-flash";
export const FALLBACK_MODEL = config.gemini?.fallbackModel || "gemini-3.6-flash";

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
 * Custom Error for AI Provider Failures (Rate Limits, Unavailable, or Invocations)
 */
export class AiProviderError extends Error {
  constructor(
    message,
    { statusCode = 503, originalError = null, code = "AI_PROVIDER_ERROR" } = {},
  ) {
    super(message);
    this.name = "AiProviderError";
    this.statusCode = statusCode;
    this.code = code;
    this.originalError = originalError;
  }
}

/**
 * Sanitize error messages originating from LLM providers (e.g. Google Gemini).
 * Prevents leaking raw API JSON structures, quota violation links, developer URLs,
 * and internal stack traces to client responses.
 *
 * @param {Error|string} err
 * @returns {string} Human-friendly error message suitable for frontend display
 */
export function sanitizeAiErrorMessage(err) {
  if (!err) return "The AI assistant is temporarily unavailable. Please try again in a moment.";

  let rawMessage = typeof err === "string" ? err : err.message || "";
  let statusCode = err.status || err.statusCode || err.code;

  // If rawMessage is stringified JSON from Google GenAI SDK (e.g. {"error":{...}}), parse it
  if (typeof rawMessage === "string") {
    const trimmed = rawMessage.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.error) {
          statusCode = statusCode || parsed.error.code;
          rawMessage = parsed.error.message || rawMessage;
        }
      } catch {
        // Not valid JSON, continue with rawMessage
      }
    }
  }

  const lower = (rawMessage || "").toLowerCase();

  // 1. Quota exceeded or Rate limited (429 / RESOURCE_EXHAUSTED)
  if (
    statusCode === 429 ||
    lower.includes("429") ||
    lower.includes("quota") ||
    lower.includes("resource_exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("requests per day")
  ) {
    return "The AI assistant is currently experiencing high demand or quota limits. Please try again in a few moments.";
  }

  // 2. High demand / Service unavailable (503 / UNAVAILABLE)
  if (
    statusCode === 503 ||
    lower.includes("503") ||
    lower.includes("unavailable") ||
    lower.includes("high demand") ||
    lower.includes("temporary spike")
  ) {
    return "The AI assistant is temporarily busy due to high demand. Please wait a moment and try again.";
  }

  // 3. Timeout (504 / Deadline Exceeded)
  if (
    statusCode === 504 ||
    lower.includes("504") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("deadline_exceeded")
  ) {
    return "The AI request took too long to complete. Please try your question again.";
  }

  // 4. Network or connectivity issues
  if (
    lower.includes("econnreset") ||
    lower.includes("fetch failed") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout")
  ) {
    return "Unable to connect to the AI service. Please check network connectivity and try again.";
  }

  // 5. Auth / API key
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    lower.includes("api key") ||
    lower.includes("api_key") ||
    lower.includes("unauthenticated") ||
    lower.includes("permission_denied")
  ) {
    return "The AI service is currently misconfigured or unauthorized. Please contact your system administrator.";
  }

  // If the message is short, clean prose without URLs, braces, or stack traces, keep it:
  if (
    typeof rawMessage === "string" &&
    rawMessage.length < 120 &&
    !rawMessage.includes("http") &&
    !rawMessage.includes("{") &&
    !rawMessage.includes("at ") &&
    !rawMessage.includes("node_modules")
  ) {
    return rawMessage;
  }

  return "An unexpected error occurred while communicating with the AI service. Please try again.";
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
    "--- FUNCTION CALLING & OPERATIONAL TOOL RULES ---",
    "1. When the user asks about company policies, leave rules, IT guidelines, or benefits, invoke the `searchPolicies` tool.",
    "2. When the user asks about their own leave balance, invoke the `getLeaveBalance` tool.",
    "3. When the user asks to view or check their open/all support tickets, invoke the `getMyTickets` tool.",
    "4. When the user requests to create or file a support ticket, invoke the `createTicket` tool.",
    "5. When the user asks to apply for leave, invoke the `applyLeave` tool.",
    "6. When the user requests a hardware upgrade or new equipment, invoke the `requestHardwareUpgrade` tool.",
    "7. For multi-faceted requests (e.g. 'check my leave balance and show my open tickets'), invoke all appropriate tools.",
    "8. If no tool is needed (e.g. greetings, general conversation, or clarifying questions), respond normally without invoking tools.",
    "",
    "--- ZERO-HALLUCINATION & CITATION RULES ---",
    "1. When verified policy excerpts are returned via `searchPolicies` (or provided in evidence), answer using ONLY that evidence.",
    "2. You MUST cite references using in-text numbered badges like [1], [2], corresponding to the policy sources.",
    '3. If searchPolicies returns no grounding or no relevant policy covers the topic, state plainly: "No company policy covers this topic. Would you like me to raise an HR or IT ticket for assistance?"',
    "4. Never fabricate policies, entitlement quotas, or corporate rules.",
    "",
    "--- HUMAN-IN-THE-LOOP (HITL) WORKFLOW ---",
    "1. Consequential tools (`applyLeave`, `requestHardwareUpgrade`) STAGE an action for confirmation; they DO NOT deduct balance or provision hardware immediately.",
    "2. When a tool stages an action, explain clearly to the user that their request has been staged and prompt them to confirm or reject using the interactive approval card.",
    "",
    evidenceContext || "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Format multi-turn conversation history into Gemini API contents structure
 * Preserves structured tool parts (functionCall, functionResponse) across conversation turns.
 *
 * @param {Array<{ role: string, text?: string, parts?: Array<Object> }>} historyTurns
 * @param {string} currentMessage Masked user query
 * @returns {Array<{ role: string, parts: Array<Object> }>}
 */
export function formatGeminiContents(historyTurns = [], currentMessage = "") {
  const contents = (historyTurns || []).map((turn) => {
    if (Array.isArray(turn.parts) && turn.parts.length > 0) {
      return {
        role:
          turn.role === "model" || turn.role === "assistant" ? "model" : "user",
        parts: turn.parts,
      };
    }
    return {
      role:
        turn.role === "model" || turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.text || "" }],
    };
  });

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
  let msg = (err.message || "").toLowerCase();
  let status = err.status || err.statusCode || err.code;

  if (typeof err.message === "string" && err.message.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(err.message.trim());
      if (parsed.error) {
        status = status || parsed.error.code;
        msg = (parsed.error.message || msg).toLowerCase();
      }
    } catch {
      // ignore
    }
  }

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
    msg.includes("high demand") ||
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
 * Call Gemini API with timeout, transient fallback model retry, tool declarations, and usage collection
 *
 * @param {Object} params
 * @param {Array} params.contents Formatted Gemini contents array
 * @param {string} params.systemInstruction System instruction string
 * @param {Array} [params.tools=null] Optional Gemini functionDeclarations array
 * @param {boolean} [params.stream=false] Whether to stream tokens
 * @param {Function} [params.onToken] Token callback for streaming
 * @param {number} [params.timeoutMs=REQUEST_TIMEOUT_MS] Request timeout in ms
 * @returns {Promise<{ text: string, functionCalls: Array, usageMetadata: Object|null }>}
 */
export async function callGemini({
  contents,
  systemInstruction,
  tools = null,
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

  if (Array.isArray(tools) && tools.length > 0) {
    modelConfig.tools = [{ functionDeclarations: tools }];
  }

  const executeModel = async (modelName) => {
    let accumulated = "";
    let rawUsage = null;
    let functionCalls = [];

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
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          functionCalls.push(...chunk.functionCalls);
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
        response.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ||
        "";

      functionCalls =
        response.functionCalls ||
        response.candidates?.[0]?.content?.parts
          ?.filter((p) => p.functionCall)
          ?.map((p) => p.functionCall) ||
        [];

      rawUsage = response.usageMetadata;
      var candidateContent = response.candidates?.[0]?.content || null;
    }

    return {
      text: accumulated,
      functionCalls,
      candidateContent: candidateContent || null,
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
        const safeMessage = sanitizeAiErrorMessage(fallbackErr);
        throw new AiProviderError(safeMessage, {
          statusCode: 503,
          originalError: fallbackErr,
          code: "AI_PROVIDER_UNAVAILABLE",
        });
      }
    }
    const safeMessage = sanitizeAiErrorMessage(primaryErr);
    throw new AiProviderError(safeMessage, {
      statusCode: primaryErr.status || 500,
      originalError: primaryErr,
      code: "AI_PROVIDER_ERROR",
    });
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
 * Helper to emit tokens to the SSE stream in word/whitespace chunks
 *
 * @param {string} text Full generated text
 * @param {Function} onEvent SSE event callback
 */
export function emitTokensToStream(text, onEvent) {
  if (!text || typeof onEvent !== "function") return;
  const tokens = text.match(/\S+\s*/g) || [text];
  for (const token of tokens) {
    onEvent("token", { delta: token });
  }
}

/**
 * Friendly status message for tool execution SSE event
 *
 * @param {string} toolName
 * @param {Object} [args={}]
 * @returns {string} Status pill message
 */
export function getToolStatusMessage(toolName, args = {}) {
  switch (toolName) {
    case "searchPolicies":
      return "Searching ABC Tech policy knowledge base in Qdrant...";
    case "getLeaveBalance":
      return "Fetching employee leave balances...";
    case "getMyTickets":
      return "Retrieving support tickets...";
    case "createTicket":
      return `Creating support ticket: "${args.title || "Support Request"}"...`;
    case "applyLeave":
      return `Staging leave application for ${args.days || 1} day(s) of ${args.leaveType || "casual"} leave...`;
    case "requestHardwareUpgrade":
      return `Staging hardware upgrade requisition for ${args.preferredModel || "hardware"}...`;
    default:
      return `Executing ${toolName}...`;
  }
}

/**
 * Execute a single function call with timeout and error trapping
 *
 * @param {Object} fc Function call { name, args, id }
 * @param {Object} context Execution context (user, redisClient, embeddingProvider, qdrantClient)
 * @returns {Promise<{ name: string, id?: string, response: Object, rawResult: Object|null }>}
 */
export async function executeSingleToolCall(fc, context) {
  const timeoutMs = 15000;
  const rawName = fc.name || "";
  const cleanName = rawName.replace(/^default_api:/, "").replace(/^.*:/, "");

  try {
    const validTools = [
      ...SAFE_TOOLS,
      ...MUTATION_TOOLS,
      ...CONSEQUENTIAL_TOOLS,
    ];

    if (!validTools.includes(cleanName)) {
      return {
        name: cleanName,
        rawName,
        id: fc.id,
        response: {
          error: true,
          message: `Tool '${cleanName}' is not recognized or authorized.`,
        },
        rawResult: null,
      };
    }

    let toolArgs = fc.args;
    if (typeof toolArgs === "string") {
      try {
        toolArgs = JSON.parse(toolArgs);
      } catch {
        toolArgs = {};
      }
    }
    if (!toolArgs || typeof toolArgs !== "object") {
      toolArgs = {};
    }

    const rawResult = await Promise.race([
      executeTool(cleanName, toolArgs, context),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Tool '${cleanName}' execution timed out after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);

    let responsePayload;
    if (rawResult?.isConsequential && rawResult?.requiresConfirmation) {
      responsePayload = {
        status: "STAGED_FOR_APPROVAL",
        requiresConfirmation: true,
        actionId: rawResult.actionId,
        actionType: rawResult.actionType,
        summary: rawResult.summary,
        message:
          rawResult.message ||
          "Action has been staged for human confirmation. An interactive approval card has been displayed to the employee. Awaiting user approval.",
      };
    } else if (cleanName === "searchPolicies") {
      responsePayload = {
        tool: "searchPolicies",
        isGrounded: Boolean(rawResult.isGrounded),
        chunksCount: (rawResult.chunks || []).length,
        policyEvidence: rawResult.contextBlock || "No matching policies found.",
        ...(rawResult.fallbackMessage
          ? { fallbackMessage: rawResult.fallbackMessage }
          : {}),
      };
    } else if (typeof rawResult === "object" && rawResult !== null) {
      responsePayload = rawResult;
    } else {
      responsePayload = { result: rawResult };
    }

    return {
      name: cleanName,
      rawName,
      id: fc.id,
      response: responsePayload,
      rawResult,
    };
  } catch (err) {
    console.error(
      `🚨 [Orchestrator] Error executing tool '${cleanName}': ${err.message}`,
    );
    return {
      name: cleanName,
      rawName,
      id: fc.id,
      response: {
        error: true,
        message: err.message || `Failed to execute ${cleanName}`,
      },
      rawResult: null,
    };
  }
}

/**
 * Controlled Gemini Native Function Calling Execution Loop
 *
 * 1. Sends user message & conversation history to Gemini with tool definitions.
 * 2. Inspects model response for function calls (response.functionCalls).
 * 3. Validates requested tool names against backend registry.
 * 4. Executes safe tools concurrently (Promise.all) and mutation/consequential tools sequentially.
 * 5. Returns structured function responses to Gemini.
 * 6. Bounds loop to maxRounds (3) to prevent infinite loops.
 * 7. Streams final natural language response tokens via SSE.
 *
 * @param {Object} params
 * @param {Array} params.contents Formatted Gemini contents array
 * @param {string} params.systemInstruction System instruction string
 * @param {Object} params.user Authenticated user
 * @param {Object} [params.redisClient] Redis client instance
 * @param {Function} [params.customEmbeddingProvider] Custom embedding provider
 * @param {Object} [params.qdrantClient] Custom Qdrant client
 * @param {boolean} [params.stream=false] Whether to stream tokens
 * @param {Function} [params.onEvent] SSE event callback: (eventName, data) => void
 * @param {number} [params.maxRounds=3] Maximum function calling rounds
 * @returns {Promise<Object>} Loop result
 */
export async function runNativeFunctionCallingLoop({
  contents,
  systemInstruction,
  user,
  redisClient = getRedisClient(),
  customEmbeddingProvider = null,
  qdrantClient = null,
  stream = false,
  onEvent = null,
  maxRounds = 3,
}) {
  const currentContents = [...contents];
  const intermediateTurns = [];
  const executedTools = [];
  const chunks = [];
  let isGrounded = true;
  let suggestedAction = null;
  let stagedAction = null;
  const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let finalAnswer = "";

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`  [NativeToolLoop] Starting round ${round}/${maxRounds}...`);

    // Call Gemini with available tool declarations
    const geminiResult = await callGemini({
      contents: currentContents,
      systemInstruction,
      tools: TOOL_DEFINITIONS,
      stream: false,
    });

    if (geminiResult.usageMetadata) {
      totalUsage.promptTokens += geminiResult.usageMetadata.promptTokens || 0;
      totalUsage.completionTokens +=
        geminiResult.usageMetadata.completionTokens || 0;
      totalUsage.totalTokens += geminiResult.usageMetadata.totalTokens || 0;
    }

    const functionCalls = geminiResult.functionCalls || [];

    // If model did not predict any function calls, it returned the final text answer
    if (!functionCalls || functionCalls.length === 0) {
      console.log(
        `  [NativeToolLoop] No function calls in round ${round}. Final response received.`,
      );
      finalAnswer = geminiResult.text || "";

      // Stream tokens to SSE callback if streaming requested
      if (stream && typeof onEvent === "function" && finalAnswer) {
        emitTokensToStream(finalAnswer, onEvent);
      }
      break;
    }

    console.log(
      `  [NativeToolLoop] Round ${round}: Model invoked ${functionCalls.length} tool(s): [${functionCalls.map((fc) => fc.name).join(", ")}]`,
    );

    // 1. Record Model Turn containing the function calls
    // IMPORTANT: Preserve the exact candidateContent returned by the model
    // (including thoughtSignature on functionCall parts and reasoning thoughts).
    // Discarding thoughtSignature causes a 400 INVALID_ARGUMENT error on subsequent turns.
    const modelTurn = geminiResult.candidateContent
      ? JSON.parse(JSON.stringify(geminiResult.candidateContent))
      : {
          role: "model",
          parts: functionCalls.map((fc) => ({
            functionCall: {
              name: fc.name,
              args: fc.args || {},
              ...(fc.id ? { id: fc.id } : {}),
            },
          })),
        };
    currentContents.push(modelTurn);
    intermediateTurns.push(modelTurn);

    // 2. Emit 'tool_call' status events
    if (typeof onEvent === "function") {
      for (const fc of functionCalls) {
        const cleanName = (fc.name || "")
          .replace(/^default_api:/, "")
          .replace(/^.*:/, "");
        onEvent("tool_call", {
          tool: cleanName,
          status: getToolStatusMessage(cleanName, fc.args),
          timestamp: new Date().toISOString(),
        });
      }
    }

    // 3. Execute tools respecting concurrency constraints:
    // Safe read-only tools run in parallel; mutation and consequential tools run sequentially.
    const isAllSafe = functionCalls.every((fc) => {
      const cleanName = (fc.name || "")
        .replace(/^default_api:/, "")
        .replace(/^.*:/, "");
      return SAFE_TOOLS.includes(cleanName);
    });
    let toolResults = [];

    const toolContext = {
      user,
      redisClient,
      embeddingProvider: customEmbeddingProvider,
      qdrantClient,
    };

    if (isAllSafe) {
      console.log(
        `  [NativeToolLoop] Executing ${functionCalls.length} safe tool(s) concurrently in parallel...`,
      );
      toolResults = await Promise.all(
        functionCalls.map((fc) => executeSingleToolCall(fc, toolContext)),
      );
    } else {
      console.log(
        `  [NativeToolLoop] Executing ${functionCalls.length} tool(s) sequentially (includes mutation or consequential actions)...`,
      );
      for (const fc of functionCalls) {
        const res = await executeSingleToolCall(fc, toolContext);
        toolResults.push(res);
      }
    }

    // 4. Process execution results and extract metadata
    for (const res of toolResults) {
      if (!executedTools.includes(res.name)) {
        executedTools.push(res.name);
      }

      if (res.rawResult) {
        // HITL Consequential Action Staged
        if (
          res.rawResult.isConsequential &&
          res.rawResult.requiresConfirmation
        ) {
          stagedAction = {
            actionId: res.rawResult.actionId,
            type: res.rawResult.actionType,
            card: res.rawResult.card,
            summary: res.rawResult.summary,
          };
          if (typeof onEvent === "function") {
            console.log(
              `  [NativeToolLoop] Emitting 'action_required' event for staged action: ${stagedAction.actionId}`,
            );
            onEvent("action_required", stagedAction);
          }
        }

        // Policy RAG Evidence Retrieval
        if (res.name === "searchPolicies") {
          if (
            Array.isArray(res.rawResult.chunks) &&
            res.rawResult.chunks.length > 0
          ) {
            chunks.push(...res.rawResult.chunks);
          }
          isGrounded = Boolean(res.rawResult.isGrounded);
          if (res.rawResult.suggestedAction) {
            suggestedAction = res.rawResult.suggestedAction;
          }
        }
      }
    }

    // 5. Record User Turn containing the function responses
    const userParts = toolResults.map((tr) => ({
      functionResponse: {
        name: tr.rawName || tr.name,
        response: tr.response,
        ...(tr.id ? { id: tr.id } : {}),
      },
    }));
    const userTurn = { role: "user", parts: userParts };
    currentContents.push(userTurn);
    intermediateTurns.push(userTurn);

    // 6. If we have reached max rounds, force final response synthesis without tools
    if (round === maxRounds) {
      console.log(
        `  [NativeToolLoop] Reached max rounds (${maxRounds}). Requesting final response without tools...`,
      );
      const finalResult = await callGemini({
        contents: currentContents,
        systemInstruction,
        tools: null,
        stream: false,
      });

      finalAnswer = finalResult.text || "";
      if (finalResult.usageMetadata) {
        totalUsage.promptTokens += finalResult.usageMetadata.promptTokens || 0;
        totalUsage.completionTokens +=
          finalResult.usageMetadata.completionTokens || 0;
        totalUsage.totalTokens += finalResult.usageMetadata.totalTokens || 0;
      }
      if (stream && typeof onEvent === "function" && finalAnswer) {
        emitTokensToStream(finalAnswer, onEvent);
      }
      break;
    }
  }

  // Fallback for ungrounded policy searches where model returned minimal text
  if (
    !isGrounded &&
    executedTools.includes("searchPolicies") &&
    (!finalAnswer || finalAnswer.trim().length < 5)
  ) {
    finalAnswer =
      "No company policy covers this topic. Would you like me to raise an HR or IT ticket for assistance?";
    if (stream && typeof onEvent === "function") {
      onEvent("token", { delta: finalAnswer });
    }
  }

  return {
    text: finalAnswer,
    chunks,
    isGrounded,
    suggestedAction,
    stagedAction,
    intermediateTurns,
    executedTools,
    usageMetadata: totalUsage.totalTokens > 0 ? totalUsage : null,
  };
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
  intermediateTurns = [],
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

  // User input turn
  await appendSessionMessage(
    sessionTarget,
    {
      role: "user",
      text: rawMessage,
      parts: [{ text: rawMessage }],
    },
    redisClient,
    user,
  );

  // Intermediate function calls and function response turns (if any)
  if (Array.isArray(intermediateTurns) && intermediateTurns.length > 0) {
    for (const interTurn of intermediateTurns) {
      await appendSessionMessage(
        sessionTarget,
        {
          role: interTurn.role,
          text: interTurn.text || "",
          parts: interTurn.parts,
        },
        redisClient,
        user,
      );
    }
  }

  // Model final response turn
  await appendSessionMessage(
    sessionTarget,
    {
      role: "model",
      text: unmaskedAnswer,
      parts: [{ text: unmaskedAnswer }],
    },
    redisClient,
    user,
  );

  // 4. Record Audit Log
  if (user?.orgId) {
    recordAuditLog({
      logId: `log_${crypto.randomUUID()}`,
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
    totalHistoryTurns:
      historyTurns.length + 2 + (intermediateTurns?.length || 0),
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

  // 4. Custom Mock LLM Provider Path (preserves test harness compatibility)
  if (typeof customLlmProvider === "function") {
    const retrievalResult = await retrievePolicyContext({
      query: maskedText,
      user,
      embeddingProvider: customEmbeddingProvider,
      qdrantClient,
    });

    const systemInstruction = buildSystemInstructions({
      user,
      evidenceContext: retrievalResult.contextBlock,
    });

    let responseText = await customLlmProvider({
      message: maskedText,
      history: historyTurns,
      systemInstruction,
      retrievalResult,
      tokenMap,
    });

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
      detectedTool: null,
      isGrounded: retrievalResult.isGrounded,
      suggestedAction: retrievalResult.suggestedAction || null,
      redisClient,
    });
  }

  // 5. Native Gemini Function Calling Lifecycle
  const systemInstruction = buildSystemInstructions({ user });
  const contents = formatGeminiContents(historyTurns, maskedText);

  const loopResult = await runNativeFunctionCallingLoop({
    contents,
    systemInstruction,
    user,
    redisClient,
    customEmbeddingProvider,
    qdrantClient,
    stream: false,
  });

  return await finalizeTurn({
    sessionId,
    user,
    rawMessage: message,
    rawAnswerText: loopResult.text,
    tokenMap,
    hasPII,
    chunks: loopResult.chunks,
    historyTurns,
    intermediateTurns: loopResult.intermediateTurns,
    detectedTool:
      loopResult.executedTools.length > 0
        ? { tool: loopResult.executedTools[0] }
        : null,
    stagedAction: loopResult.stagedAction,
    usageMetadata: loopResult.usageMetadata,
    isGrounded: loopResult.isGrounded,
    suggestedAction: loopResult.suggestedAction,
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
 * @param {Object} [params.explicitToolCall] Deprecated direct tool trigger (ignored in production)
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
  const turnStartTime = Date.now();
  console.log(
    `\n▶️ [Orchestrator:streamCopilotTurn] Initializing turn for session: '${sessionId}' | User: ${user?.userId} (${user?.role}) | Org: ${user?.orgId}`,
  );

  if (!sessionId) {
    console.error(`❌ [Orchestrator:streamCopilotTurn] Missing sessionId.`);
    throw new Error("sessionId is required for copilot conversation.");
  }
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    console.error(`❌ [Orchestrator:streamCopilotTurn] Missing user message.`);
    throw new Error("User message is required.");
  }
  if (!user || !user.orgId || !user.userId) {
    console.error(
      `❌ [Orchestrator:streamCopilotTurn] Incomplete user context:`,
      user,
    );
    throw new Error(
      "Authenticated user context with orgId and userId is required.",
    );
  }
  if (typeof onEvent !== "function") {
    console.error(
      `❌ [Orchestrator:streamCopilotTurn] Missing onEvent callback.`,
    );
    throw new Error("onEvent callback function is required for SSE streaming.");
  }

  // 1. Validate Session Ownership & Isolation
  console.log(`  [Step 1/5] Validating session ownership in orchestrator...`);
  await validateSessionOwnership({ sessionId, user, client: redisClient });
  console.log(`  [Step 1/5] Session ownership validated.`);

  // 2. Pre-LLM PII Masking
  console.log(`  [Step 2/5] Running PII masking on input prompt...`);
  const { maskedText, tokenMap, hasPII } = maskPII(message);
  console.log(
    `  [Step 2/5] PII masking complete. hasPII: ${hasPII}, entities masked: ${Object.keys(tokenMap).length}`,
  );

  // 3. Load Multi-Turn History (scoped by orgId + userId + sessionId)
  console.log(
    `  [Step 3/5] Loading sliding-window session history from Redis...`,
  );
  const sessionTarget = { sessionId, orgId: user.orgId, userId: user.userId };
  const historyTurns = await getSessionHistory(
    sessionTarget,
    redisClient,
    user,
  );
  console.log(`  [Step 3/5] Retrieved ${historyTurns.length} history turn(s).`);

  // 4. Custom Mock LLM Stream Provider Path (preserves test harness compatibility)
  if (typeof customLlmStreamProvider === "function") {
    console.log(`  [Step 4/5] Using custom mock LLM stream provider.`);
    onEvent("tool_call", {
      tool: "searchPolicies",
      status: "Searching ABC Tech policy knowledge base in Qdrant...",
      timestamp: new Date().toISOString(),
    });

    const retrievalResult = await retrievePolicyContext({
      query: maskedText,
      user,
      embeddingProvider: customEmbeddingProvider,
      qdrantClient,
    });

    const systemInstruction = buildSystemInstructions({
      user,
      evidenceContext: retrievalResult.contextBlock,
    });

    let accumulatedText = "";
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

    const finalSummary = await finalizeTurn({
      sessionId,
      user,
      rawMessage: message,
      rawAnswerText: accumulatedText,
      tokenMap,
      hasPII,
      chunks: retrievalResult.chunks,
      historyTurns,
      detectedTool: { tool: "searchPolicies" },
      isGrounded: retrievalResult.isGrounded,
      suggestedAction: retrievalResult.suggestedAction || null,
      redisClient,
    });

    onEvent("citation", {
      hasCitations: finalSummary.hasCitations,
      citations: finalSummary.citations,
      activeCitations: finalSummary.activeCitations,
    });

    onEvent("done", {
      sessionId,
      totalHistoryTurns: finalSummary.totalHistoryTurns,
      hasCitations: finalSummary.hasCitations,
      hasActionRequired: false,
      completedAt: new Date().toISOString(),
    });

    return finalSummary;
  }

  // 5. Native Gemini Function Calling Lifecycle
  console.log(`  [Step 4/5] Running Gemini Native Function Calling loop...`);
  const systemInstruction = buildSystemInstructions({ user });
  const contents = formatGeminiContents(historyTurns, maskedText);

  const loopResult = await runNativeFunctionCallingLoop({
    contents,
    systemInstruction,
    user,
    redisClient,
    customEmbeddingProvider,
    qdrantClient,
    stream: true,
    onEvent,
  });

  // 6. Finalize Turn
  console.log(
    `  [Step 5/5] Finalizing turn, unmasking PII, recording audit log, and persisting to Redis...`,
  );
  const finalSummary = await finalizeTurn({
    sessionId,
    user,
    rawMessage: message,
    rawAnswerText: loopResult.text,
    tokenMap,
    hasPII,
    chunks: loopResult.chunks,
    historyTurns,
    intermediateTurns: loopResult.intermediateTurns,
    detectedTool:
      loopResult.executedTools.length > 0
        ? { tool: loopResult.executedTools[0] }
        : null,
    stagedAction: loopResult.stagedAction,
    usageMetadata: loopResult.usageMetadata,
    isGrounded: loopResult.isGrounded,
    suggestedAction: loopResult.suggestedAction,
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
    hasActionRequired: Boolean(loopResult.stagedAction),
    completedAt: new Date().toISOString(),
    usage: loopResult.usageMetadata || undefined,
  });

  console.log(
    `✅ [Orchestrator:streamCopilotTurn] Turn successfully finished in ${Date.now() - turnStartTime}ms for session: '${sessionId}'\n`,
  );

  return finalSummary;
}
