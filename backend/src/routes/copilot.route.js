import { Router } from "express";
import {
  streamChat,
  approveAction,
  rejectAction,
  getActionDetails,
} from "../controllers/copilot.controller.js";
import { authenticateJwt } from "../middlewares/auth.middleware.js";

const router = Router();

// Protect all copilot routes with enterprise JWT authentication
router.use(authenticateJwt);

/**
 * @route   POST /api/copilot/chat
 * @desc    Stream Copilot chat responses via Server-Sent Events (SSE)
 * @access  Private (All Roles)
 */
router.post("/chat", streamChat);

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

export default router;
