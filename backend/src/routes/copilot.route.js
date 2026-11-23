import { Router } from "express";
import multer from "multer";
import {
  streamChat,
  approveAction,
  rejectAction,
  getActionDetails,
  uploadDocument,
  listDocuments,
} from "../controllers/copilot.controller.js";
import { authenticateJwt, requireRoles } from "../middlewares/auth.middleware.js";

const router = Router();

// Configure Multer for in-memory document uploads (Max 10MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

// Protect all copilot routes with enterprise JWT authentication
router.use(authenticateJwt);

/**
 * @route   POST /api/copilot/chat
 * @desc    Stream Copilot chat responses via Server-Sent Events (SSE)
 * @access  Private (All Roles)
 */
router.post("/chat", (req, res, next) => {
  const reqTime = new Date().toISOString();
  console.log(`\n================================================================================`);
  console.log(`🚀 [Copilot Route] POST /api/copilot/chat received at ${reqTime}`);
  console.log(`   Client IP: ${req.ip || req.socket?.remoteAddress || 'unknown'}`);
  console.log(`   User: ${req.user?.userId || 'anonymous'} (Org: ${req.user?.orgId || 'none'}, Role: ${req.user?.role || 'none'}, Dept: ${req.user?.department || 'none'})`);
  console.log(`   SessionId: ${req.body?.sessionId || '(auto-generated)'}`);
  console.log(`   Message Length: ${req.body?.message?.length || 0} chars`);
  console.log(`   Explicit ToolCall: ${req.body?.toolCall ? JSON.stringify(req.body.toolCall) : 'none'}`);
  console.log(`================================================================================`);
  return streamChat(req, res, next);
});

/**
 * @route   POST /api/copilot/action/approve
 * @desc    Approve and commit a staged consequential action (HITL)
 * @access  Private (All Roles)
 */
router.post("/action/approve", approveAction);

/**
 * @route   POST /api/copilot/action/reject
 * @desc    Reject and cancel a staged consequential action
 * @access  Private (All Roles)
 */
router.post("/action/reject", rejectAction);

/**
 * @route   GET /api/copilot/action/:actionId
 * @desc    Inspect metadata of a pending staged action
 * @access  Private (All Roles)
 */
router.get("/action/:actionId", getActionDetails);

/**
 * @route   POST /api/copilot/documents
 * @desc    Upload and ingest enterprise policy document into Qdrant
 * @access  Private (Admins & Managers)
 */
router.post(
  "/documents",
  requireRoles("super_admin", "org_admin", "hr_admin", "it_admin", "manager"),
  upload.single("file"),
  uploadDocument
);

/**
 * @route   GET /api/copilot/documents
 * @desc    List ingested policy documents indexed in Qdrant
 * @access  Private (Admins & Managers)
 */
router.get(
  "/documents",
  requireRoles("super_admin", "org_admin", "hr_admin", "it_admin", "manager"),
  listDocuments
);

export default router;
