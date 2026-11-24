import React, { createContext, useContext, useState } from 'react';
import { toast } from 'sonner';
import { copilotService } from '../services';
import { useAuth } from './AuthContext';
import {
  useApproveActionMutation,
  useRejectActionMutation,
  useInvalidateForTools,
} from '../queries/copilot.queries';

/**
 * Chat session state (messages, streaming, citations, HITL cards).
 * Server data (leave balance, tickets) lives in TanStack Query — see src/queries.
 * Mounted per signed-in user (keyed by userId in App), so switching accounts
 * always starts a fresh conversation.
 */

const CopilotContext = createContext(null);

function formatUserFacingError(raw) {
  if (!raw) return 'The AI assistant is temporarily unavailable. Please try again.';
  let msg = typeof raw === 'string' ? raw : raw?.message || '';

  if (typeof msg === 'string') {
    const trimmed = msg.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.error?.message) {
          msg = parsed.error.message;
        }
      } catch {
        // not valid JSON
      }
    }
  }

  const lower = (msg || '').toLowerCase();
  if (
    lower.includes('quota') ||
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('requests per day')
  ) {
    return 'The AI assistant is currently experiencing high demand or quota limits. Please try again in a few moments.';
  }
  if (
    lower.includes('503') ||
    lower.includes('high demand') ||
    lower.includes('unavailable')
  ) {
    return 'The AI assistant is temporarily busy due to high demand. Please try again shortly.';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'The request took too long to complete. Please try again.';
  }

  return msg;
}

export function CopilotProvider({ children }) {
  const { user } = useAuth();

  const [sessionId, setSessionId] = useState(`sess_${user?.userId || 'guest'}_${Date.now().toString(36)}`);
  const [messages, setMessages] = useState([
    {
      id: 'welcome_1',
      sender: 'assistant',
      text: `Hello ${user?.name?.split(' ')[0] || 'there'}! I am OmniDesk AI, your enterprise operations copilot. How can I assist you with company policies, leave applications, or support tickets today?`,
      timestamp: new Date().toISOString(),
      citations: [],
    },
  ]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeToolPill, setActiveToolPill] = useState(null); // { tool, status, pill }

  // Evidence Drawer state
  const [citationsList, setCitationsList] = useState([]);
  const [selectedCitation, setSelectedCitation] = useState(null);
  const [isCitationDrawerOpen, setIsCitationDrawerOpen] = useState(false);

  const { mutateAsync: approveAsync } = useApproveActionMutation();
  const { mutateAsync: rejectAsync } = useRejectActionMutation();
  const invalidateForTools = useInvalidateForTools();

  // Clear chat session and start fresh
  const clearChat = () => {
    const newSessionId = `sess_${user?.userId || 'guest'}_${Date.now().toString(36)}`;
    setSessionId(newSessionId);
    setMessages([
      {
        id: 'welcome_' + Date.now(),
        sender: 'assistant',
        text: `Session reset. I am ready to help you with company policies, leave applications, or support tickets.`,
        timestamp: new Date().toISOString(),
        citations: [],
      },
    ]);
    setActiveToolPill(null);
    toast.info('Chat session reset', { description: 'New conversational session initiated.' });
  };

  // Open Citation Drawer
  const openCitation = (citationOrBadge) => {
    if (typeof citationOrBadge === 'string') {
      const found = citationsList.find((c) => c.badge === citationOrBadge);
      if (found) {
        setSelectedCitation(found);
        setIsCitationDrawerOpen(true);
        return;
      }
    } else if (citationOrBadge) {
      setSelectedCitation(citationOrBadge);
      setIsCitationDrawerOpen(true);
    }
  };

  const closeCitationDrawer = () => {
    setIsCitationDrawerOpen(false);
  };

  // SSE Chat Turn Execution via copilotService
  const sendMessage = async (rawMessage) => {
    const text = rawMessage?.trim();
    if (!text || isStreaming) return;

    const userMessageId = `msg_user_${Date.now()}`;
    const assistantMessageId = `msg_asst_${Date.now()}`;

    // Add user message to timeline immediately
    setMessages((prev) => [
      ...prev,
      {
        id: userMessageId,
        sender: 'user',
        text,
        timestamp: new Date().toISOString(),
      },
      {
        id: assistantMessageId,
        sender: 'assistant',
        text: '',
        timestamp: new Date().toISOString(),
        citations: [],
        stagedAction: null,
      },
    ]);

    setIsStreaming(true);
    setActiveToolPill(null);

    // Tools executed during this turn decide which side panels to refresh afterwards
    const toolsUsed = new Set();

    try {
      await copilotService.streamChat({
        message: text,
        sessionId,
        onEvent: (event, payload) => {
          console.log(`[Copilot SSE] Event: ${event}`, payload);

          if (event === 'tool_call') {
            if (payload.tool) toolsUsed.add(payload.tool);
            setActiveToolPill({
              tool: payload.tool,
              status: payload.status,
              pill: payload.statusPill,
            });
          } else if (event === 'token') {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? { ...msg, text: msg.text + (payload.delta || '') }
                  : msg
              )
            );
          } else if (event === 'citation') {
            if (payload.hasCitations && Array.isArray(payload.citations)) {
              setCitationsList((existing) => {
                const combined = [...existing];
                for (const c of payload.citations) {
                  if (!combined.some((item) => item.badge === c.badge)) {
                    combined.push(c);
                  }
                }
                return combined;
              });

              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessageId
                    ? { ...msg, citations: payload.citations }
                    : msg
                )
              );
            }
          } else if (event === 'action_required') {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      stagedAction: {
                        actionId: payload.actionId,
                        type: payload.type,
                        card: payload.card,
                        status: 'PENDING',
                      },
                    }
                  : msg
              )
            );
            toast.warning('Action Required', {
              description: payload.card?.title || 'A consequential action requires your approval.',
            });
          } else if (event === 'done') {
            setActiveToolPill(null);
            setIsStreaming(false);
          } else if (event === 'error') {
            setActiveToolPill(null);
            setIsStreaming(false);
            const userError = formatUserFacingError(payload?.message);
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      text:
                        (msg.text ? msg.text + '\n\n' : '') +
                        `*(Error: ${userError})*`,
                    }
                  : msg
              )
            );
            toast.error('Response Error', {
              description: userError,
            });
          }
        },
      });
    } catch (err) {
      const userError = formatUserFacingError(err?.message);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                text:
                  msg.text ||
                  `Sorry, I encountered an issue connecting to the assistant: ${userError}`,
              }
            : msg
        )
      );
      toast.error('Connection Failed', { description: userError });
    } finally {
      setIsStreaming(false);
      setActiveToolPill(null);
      // e.g. "create a ticket for my broken laptop" runs createTicket directly from chat
      invalidateForTools([...toolsUsed]);
    }
  };

  // HITL Action Approval (balance/ticket queries are invalidated by the mutation;
  // failures toast via the mutation's meta.errorTitle)
  const approveAction = async (actionId) => {
    const res = await approveAsync(actionId);

    setMessages((prev) =>
      prev.map((msg) =>
        msg.stagedAction?.actionId === actionId
          ? { ...msg, stagedAction: { ...msg.stagedAction, status: 'APPROVED', result: res.data } }
          : msg
      )
    );

    toast.success('Action Approved & Executed', {
      description: res.data?.message || 'Database mutation committed and notification queued.',
    });

    return res;
  };

  // HITL Action Rejection
  const rejectAction = async (actionId) => {
    const res = await rejectAsync(actionId);

    setMessages((prev) =>
      prev.map((msg) =>
        msg.stagedAction?.actionId === actionId
          ? { ...msg, stagedAction: { ...msg.stagedAction, status: 'REJECTED' } }
          : msg
      )
    );

    toast.info('Action Rejected', {
      description: 'The staged consequential action was safely cancelled.',
    });

    return res;
  };

  return (
    <CopilotContext.Provider
      value={{
        sessionId,
        setSessionId,
        messages,
        isStreaming,
        activeToolPill,
        sendMessage,
        clearChat,
        // Citations
        citationsList,
        selectedCitation,
        isCitationDrawerOpen,
        openCitation,
        closeCitationDrawer,
        // HITL actions
        approveAction,
        rejectAction,
      }}
    >
      {children}
    </CopilotContext.Provider>
  );
}

export function useCopilot() {
  const context = useContext(CopilotContext);
  if (!context) {
    throw new Error('useCopilot must be used within a CopilotProvider');
  }
  return context;
}
