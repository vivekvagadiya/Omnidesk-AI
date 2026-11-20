import { initSSE, sendSSE, closeSSE } from '../utils/sse.js';
import { streamCopilotTurn } from '../services/ai/orchestrator.service.js';
import {
  consumeActionToken,
  getStagedAction,
  HITLError,
  ActionNotFoundError,
  ActionExpiredError,
  UnauthorizedActionError,
} from '../services/tools/hitlGatekeeper.service.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';
import { getRedisClient } from '../config/redis.js';

/**
 * Controller: Stream Copilot Chat with SSE
 * POST /api/copilot/chat
 */
export async function streamChat(req, res, next) {
  const { message, sessionId, toolCall } = req.body;
  const user = req.user;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Unauthorized: Valid user credentials required.',
    });
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return errorResponse(res, {
      statusCode: 400,
      message: 'Message text is required.',
    });
  }

  const activeSessionId = sessionId && typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId.trim()
    : `sess_${user.userId}`;

  // Initialize SSE connection headers
  initSSE(res);

  let isAborted = false;
  req.on('close', () => {
    isAborted = true;
  });

  try {
    await streamCopilotTurn({
      sessionId: activeSessionId,
      message: message.trim(),
      user,
      onEvent: (event, data) => {
        if (!isAborted) {
          sendSSE(res, event, data);
        }
      },
      explicitToolCall: toolCall || null,
    });
  } catch (err) {
    if (!res.headersSent) {
      return errorResponse(res, {
        statusCode: 500,
        message: err.message || 'An error occurred during chat turn execution.',
      });
    }

    sendSSE(res, 'error', {
      message: err.message || 'Internal streaming error.',
      code: 'COPILOT_STREAM_ERROR',
    });
  } finally {
    closeSSE(res);
  }
}

/**
 * Controller: Approve Consequential Action Token
 * POST /api/copilot/action/approve
 */
export async function approveAction(req, res) {
  const { actionId } = req.body;
  const user = req.user;

  if (!actionId || typeof actionId !== 'string') {
    return errorResponse(res, {
      statusCode: 400,
      message: "Field 'actionId' is required.",
    });
  }

  try {
    const result = await consumeActionToken({
      actionId: actionId.trim(),
      user,
      decision: 'APPROVE',
    });

    // Enqueue async notification event to Redis queue for background worker
    try {
      const redis = getRedisClient();
      if (redis && redis.isOpen) {
        await redis.lPush(
          'queue:notifications',
          JSON.stringify({
            event: 'ACTION_APPROVED',
            actionId: actionId.trim(),
            userId: user.userId,
            orgId: user.orgId,
            type: result.type,
            details: result.result,
            createdAt: new Date().toISOString(),
          })
        );
      }
    } catch (queueErr) {
      console.warn(`⚠️ [Notification Queue] Failed to push notification: ${queueErr.message}`);
    }

    return successResponse(res, {
      statusCode: 200,
      message: result.message || 'Action approved and executed successfully.',
      data: result,
    });
  } catch (err) {
    if (err instanceof ActionNotFoundError) {
      return errorResponse(res, { statusCode: 404, message: err.message });
    }
    if (err instanceof ActionExpiredError) {
      return errorResponse(res, { statusCode: 410, message: err.message });
    }
    if (err instanceof UnauthorizedActionError) {
      return errorResponse(res, { statusCode: 403, message: err.message });
    }
    if (err instanceof HITLError) {
      return errorResponse(res, { statusCode: err.statusCode || 400, message: err.message });
    }

    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Internal server error during action approval.',
    });
  }
}

/**
 * Controller: Reject Consequential Action Token
 * POST /api/copilot/action/reject
 */
export async function rejectAction(req, res) {
  const { actionId } = req.body;
  const user = req.user;

  if (!actionId || typeof actionId !== 'string') {
    return errorResponse(res, {
      statusCode: 400,
      message: "Field 'actionId' is required.",
    });
  }

  try {
    const result = await consumeActionToken({
      actionId: actionId.trim(),
      user,
      decision: 'REJECT',
    });

    return successResponse(res, {
      statusCode: 200,
      message: result.message || 'Action rejected.',
      data: result,
    });
  } catch (err) {
    if (err instanceof ActionNotFoundError) {
      return errorResponse(res, { statusCode: 404, message: err.message });
    }
    if (err instanceof ActionExpiredError) {
      return errorResponse(res, { statusCode: 410, message: err.message });
    }
    if (err instanceof UnauthorizedActionError) {
      return errorResponse(res, { statusCode: 403, message: err.message });
    }
    if (err instanceof HITLError) {
      return errorResponse(res, { statusCode: err.statusCode || 400, message: err.message });
    }

    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Internal server error during action rejection.',
    });
  }
}

/**
 * Controller: Get Staged Action Details
 * GET /api/copilot/action/:actionId
 */
export async function getActionDetails(req, res) {
  const { actionId } = req.params;
  const user = req.user;

  if (!actionId) {
    return errorResponse(res, {
      statusCode: 400,
      message: 'Parameter actionId is required.',
    });
  }

  try {
    const staged = await getStagedAction(actionId.trim());

    if (!staged) {
      return errorResponse(res, {
        statusCode: 404,
        message: 'Action token not found or expired.',
      });
    }

    if (staged.orgId !== user.orgId) {
      return errorResponse(res, {
        statusCode: 403,
        message: 'Access denied: Foreign tenant action.',
      });
    }

    return successResponse(res, {
      statusCode: 200,
      data: staged,
    });
  } catch (err) {
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Failed to retrieve staged action.',
    });
  }
}
