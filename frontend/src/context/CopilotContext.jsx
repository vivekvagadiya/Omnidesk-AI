import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { copilotService, ticketService, profileService } from '../services';
import { useAuth } from './AuthContext';

const CopilotContext = createContext(null);

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

  // Operations state
  const [leaveBalance, setLeaveBalance] = useState({ casual: 12, sick: 7, maternity: 90 });
  const [tickets, setTickets] = useState([]);
  const [ticketScope, setTicketScope] = useState('mine'); // 'mine' | 'all'
  const [isLoadingOps, setIsLoadingOps] = useState(false);
  const [notificationsCount, setNotificationsCount] = useState(2);

  // Fetch live leave balance
  const fetchLeaveBalance = useCallback(async () => {
    if (!user) return;
    try {
      const data = await profileService.getLeaveBalance();
      if (data?.leaveBalances) {
        setLeaveBalance(data.leaveBalances);
      }
    } catch (err) {
      console.warn('Could not fetch leave balance:', err.message);
    }
  }, [user]);

  // Fetch tickets
  const fetchTickets = useCallback(
    async (scope = ticketScope) => {
      if (!user) return;
      try {
        const isManagerOrAdmin = ['manager', 'org_admin', 'super_admin', 'hr_admin', 'it_admin'].includes(
          user?.role
        );
        const params = { limit: 25 };
        if (!isManagerOrAdmin || scope !== 'all') {
          params.userId = user.userId;
        }

        const data = await ticketService.getTickets(params);
        if (data?.tickets) {
          setTickets(data.tickets);
        }
      } catch (err) {
        console.warn('Could not fetch tickets:', err.message);
      }
    },
    [user, ticketScope]
  );

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

  // Initial data load when user logs in
  useEffect(() => {
    if (user) {
      setIsLoadingOps(true);
      Promise.all([fetchLeaveBalance(), fetchTickets()]).finally(() => setIsLoadingOps(false));
    }
  }, [user, fetchLeaveBalance, fetchTickets]);

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

    try {
      await copilotService.streamChat({
        message: text,
        sessionId,
        onEvent: (event, payload) => {
          console.log(`[Copilot SSE] Event: ${event}`, payload);

          if (event === 'tool_call') {
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
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      text:
                        (msg.text ? msg.text + '\n\n' : '') +
                        `*(Error: ${payload.message || 'Stream turn encountered an issue.'})*`,
                    }
                  : msg
              )
            );
            toast.error('Response Error', {
              description: payload.message || 'Error occurred while streaming response.',
            });
          }
        },
      });
    } catch (err) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                text:
                  msg.text ||
                  `Sorry, I encountered an issue connecting to the assistant: ${err.message}`,
              }
            : msg
        )
      );
      toast.error('Connection Failed', { description: err.message });
    } finally {
      setIsStreaming(false);
      setActiveToolPill(null);
    }
  };

  // HITL Action Approval
  const approveAction = async (actionId) => {
    try {
      const res = await copilotService.approveAction(actionId);

      // Update message card state
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.stagedAction?.actionId === actionId) {
            return {
              ...msg,
              stagedAction: {
                ...msg.stagedAction,
                status: 'APPROVED',
                result: res.data,
              },
            };
          }
          return msg;
        })
      );

      // Silently refresh profile balance and tickets live
      await Promise.all([fetchLeaveBalance(), fetchTickets()]);
      setNotificationsCount((c) => c + 1);

      toast.success('Action Approved & Executed', {
        description: res.data?.message || 'Database mutation committed and notification queued.',
      });

      return res;
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      toast.error('Approval Failed', { description: msg });
      throw err;
    }
  };

  // HITL Action Rejection
  const rejectAction = async (actionId) => {
    try {
      const res = await copilotService.rejectAction(actionId);

      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.stagedAction?.actionId === actionId) {
            return {
              ...msg,
              stagedAction: {
                ...msg.stagedAction,
                status: 'REJECTED',
              },
            };
          }
          return msg;
        })
      );

      toast.info('Action Rejected', {
        description: 'The staged consequential action was safely cancelled.',
      });

      return res;
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      toast.error('Rejection Failed', { description: msg });
      throw err;
    }
  };

  // Direct Ticket Creation
  const createNewTicket = async ({ title, description, category, priority }) => {
    const res = await ticketService.createTicket({ title, description, category, priority });
    await fetchTickets();
    setNotificationsCount((c) => c + 1);

    toast.success('Support Ticket Created', {
      description: `Ticket ${res?.ticketId || ''} created under ${category}.`,
    });

    return res;
  };

  // Policy Document Upload
  const uploadPolicyDocument = async (file, department) => {
    const res = await copilotService.uploadDocument(file, department || user?.department || 'GENERAL');
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
        // Ops & Actions
        leaveBalance,
        tickets,
        ticketScope,
        setTicketScope: (newScope) => {
          setTicketScope(newScope);
          fetchTickets(newScope);
        },
        isLoadingOps,
        notificationsCount,
        approveAction,
        rejectAction,
        createNewTicket,
        uploadPolicyDocument,
        refetchOps: () => Promise.all([fetchLeaveBalance(), fetchTickets()]),
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
