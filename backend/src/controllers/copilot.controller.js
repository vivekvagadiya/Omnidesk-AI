import { initSSE, sendSSE, closeSSE } from '../utils/sse.js';
import {
  streamCopilotTurn,
  validateSessionOwnership,
  SessionOwnershipError,
} from '../services/ai/orchestrator.service.js';
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
import { recordAuditLog } from '../services/audit/audit.service.js';

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

  // Validate session ownership before establishing SSE connection to fail fast with 403
  try {
    await validateSessionOwnership({
      sessionId: activeSessionId,
      user,
    });
  } catch (err) {
    if (err instanceof SessionOwnershipError || err.statusCode === 403) {
      return errorResponse(res, {
        statusCode: 403,
        message: err.message || 'Forbidden: Session does not belong to the authenticated user.',
      });
    }
    return errorResponse(res, {
      statusCode: 500,
      message: err.message || 'Failed to validate session ownership.',
    });
  }

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
      const statusCode = (err instanceof SessionOwnershipError || err.statusCode === 403) ? 403 : 500;
      return errorResponse(res, {
        statusCode,
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

    recordAuditLog({
      orgId: user.orgId,
      actor: {
        userId: user.userId,
        name: user.name || user.userId,
        role: user.role,
      },
      action: 'DOCUMENT_UPLOADED',
      entity: {
        type: 'document',
        id: result?.docId || req.file.originalname,
      },
      changes: {
        after: {
          filename: req.file.originalname,
          department: targetDepartment,
          allowedRoles: parsedRoles,
          chunksIndexed: result?.chunksIndexed || 0,
        },
      },
      metadata: {
        ipAddress: req.ip || req.headers?.['x-forwarded-for'] || null,
        userAgent: req.headers?.['user-agent'] || null,
      },
    }).catch(() => {});

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

/**
 * Controller: List Ingested Policy Documents
 * GET /api/copilot/documents
 */
export async function listDocuments(req, res) {
  const user = req.user;

  if (!user || !user.orgId) {
    return errorResponse(res, {
      statusCode: 401,
      message: 'Unauthorized: Valid user credentials required.',
    });
  }

  const documents = [
    {
      documentId: 'doc_hr_handbook',
      name: 'ABC Technologies Employee Handbook 2026',
      department: 'HR',
      totalChunks: 14,
      allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
      status: 'INDEXED_QDRANT',
      lastIndexedAt: '2026-11-20T10:00:00.000Z',
    },
    {
      documentId: 'doc_it_security',
      name: 'Corporate IT Security & Hardware SOP',
      department: 'IT',
      totalChunks: 9,
      allowedRoles: ['employee', 'manager', 'it_admin', 'org_admin'],
      status: 'INDEXED_QDRANT',
      lastIndexedAt: '2026-11-20T10:30:00.000Z',
    },
    {
      documentId: 'doc_leave_guidelines',
      name: 'Comprehensive Leave & Attendance Policy § 4.2',
      department: 'HR',
      totalChunks: 8,
      allowedRoles: ['employee', 'manager', 'hr_admin', 'org_admin'],
      status: 'INDEXED_QDRANT',
      lastIndexedAt: '2026-11-21T09:15:00.000Z',
    },
  ];

  return successResponse(res, {
    statusCode: 200,
    message: 'Policy documents retrieved successfully.',
    data: {
      documents,
      totalCount: documents.length,
    },
  });
}
