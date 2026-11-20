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
import {
  ingestDocument,
  IngestionValidationError,
} from '../services/rag/ingestion.service.js';
import { successResponse, errorResponse } from '../utils/apiResponse.js';
import { enqueueNotification } from '../services/queue/notificationWorker.js';

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

  console.log(`\n💬 [Copilot Chat] User: ${user.name || user.userId} (${user.role}) | Session: ${activeSessionId}`);
  console.log(`💬 [Copilot Chat] Prompt: "${message.trim()}"`);

  // Initialize SSE connection headers
  initSSE(res);

  let isAborted = false;
  req.on('close', () => {
    isAborted = true;
    console.log(`⚠️  [Copilot Chat] Client disconnected / aborted SSE connection for session: ${activeSessionId}`);
  });

  try {
    await streamCopilotTurn({
      sessionId: activeSessionId,
      message: message.trim(),
      user,
      onEvent: (event, data) => {
        if (!isAborted) {
          if (event === 'token') {
            process.stdout.write(data?.delta || '');
          } else {
            console.log(`\n📡 [SSE Event: ${event}]`, typeof data === 'object' ? JSON.stringify(data).substring(0, 120) : data);
          }
          sendSSE(res, event, data);
        }
      },
      explicitToolCall: toolCall || null,
    });
  } catch (err) {
    console.error(`\n❌ [Copilot Chat] Error during stream:`, err.message);
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
    console.log(`\n🏁 [Copilot Chat] Stream completed & closed for session: ${activeSessionId}\n`);
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

    // Async notification for the background worker
    await enqueueNotification({
      event: 'ACTION_APPROVED',
      actionId: actionId.trim(),
      userId: user.userId,
      orgId: user.orgId,
      type: result.type,
      details: result.result,
      createdAt: new Date().toISOString(),
    });

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

/**
 * Controller: Upload and Ingest Document
 * POST /api/copilot/documents
 */
export async function uploadDocument(req, res) {
  const user = req.user;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Unauthorized: Valid user credentials required.',
    });
  }

  if (!req.file) {
    return errorResponse(res, {
      statusCode: 400,
      message: "No document file provided. Please attach a file using the 'file' form-data field.",
    });
  }

  const { department, allowedRoles } = req.body;
  const targetDepartment = department?.trim() || user.department || 'GENERAL';

  let parsedRoles = ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'];
  if (allowedRoles) {
    if (Array.isArray(allowedRoles)) {
      parsedRoles = allowedRoles;
    } else if (typeof allowedRoles === 'string') {
      try {
        const jsonParsed = JSON.parse(allowedRoles);
        if (Array.isArray(jsonParsed)) parsedRoles = jsonParsed;
        else parsedRoles = allowedRoles.split(',').map((r) => r.trim()).filter(Boolean);
      } catch {
        parsedRoles = allowedRoles.split(',').map((r) => r.trim()).filter(Boolean);
      }
    }
  }

  try {
    const result = await ingestDocument({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      orgId: user.orgId,
      department: targetDepartment,
      allowedRoles: parsedRoles,
      testEmbeddingProvider: req.testEmbeddingProvider || req.app?.locals?.testEmbeddingProvider || null,
      qdrantClient: req.qdrantClient || req.app?.locals?.qdrantClient || null,
    });

    return successResponse(res, {
      statusCode: 201,
      message: 'Document successfully ingested and indexed into vector database.',
      data: result,
    });
  } catch (err) {
    if (err instanceof IngestionValidationError) {
      return errorResponse(res, {
        statusCode: err.statusCode || 400,
        message: err.message,
      });
    }

    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'An error occurred during document ingestion.',
    });
  }
}
