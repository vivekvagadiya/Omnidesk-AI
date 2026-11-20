import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, getStoredAccessToken } from '../services/api';
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
  const [activeToolPill, setActiveToolPill] = useState(null); // { tool, status, statusPill }

  // Evidence Drawer state
  const [citationsList, setCitationsList] = useState([]);
  const [selectedCitation, setSelectedCitation] = useState(null);
  const [isCitationDrawerOpen, setIsCitationDrawerOpen] = useState(false);

  // Operations state
  const [leaveBalance, setLeaveBalance] = useState({ casual: 12, sick: 7, maternity: 90 });
  const [tickets, setTickets] = useState([]);
  const [isLoadingOps, setIsLoadingOps] = useState(false);
  const [notificationsCount, setNotificationsCount] = useState(2);

  // Fetch live leave balance
  const fetchLeaveBalance = useCallback(async () => {
    if (!user) return;
    try {
      const res = await api.get('/profile/balance');
      if (res.data?.data?.leaveBalances) {
        setLeaveBalance(res.data.data.leaveBalances);
      }
    } catch (err) {
      console.warn('Could not fetch leave balance:', err.message);
    }
  }, [user]);

  // Fetch tickets
  const fetchTickets = useCallback(async () => {
    if (!user) return;
    try {
      const res = await api.get('/tickets?limit=10');
      if (res.data?.data?.tickets) {
        setTickets(res.data.data.tickets);
      }
    } catch (err) {
      console.warn('Could not fetch tickets:', err.message);
    }
  }, [user]);

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

  // SSE Chat Turn Execution
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

    const token = getStoredAccessToken();

    try {
      const response = await fetch('/api/copilot/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: text,
          sessionId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Server error (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // Keep remainder in buffer

        for (const block of lines) {
          const trimmed = block.trim();
          if (!trimmed) continue;

          let event = 'message';
          let dataStr = '';

          const rows = trimmed.split('\n');
          for (const row of rows) {
            if (row.startsWith('event: ')) event = row.replace('event: ', '').trim();
            else if (row.startsWith('data: ')) dataStr = row.replace('data: ', '').trim();
          }

          if (!dataStr) continue;

          let payload = null;
          try {
            payload = JSON.parse(dataStr);
          } catch {
            payload = dataStr;
          }

          // Handle structured SSE events
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
          } else if (event === 'done') {
            setActiveToolPill(null);
          } else if (event === 'error') {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      text:
                        msg.text +
                        `\n\n*(Error: ${payload.message || 'Stream turn encountered an issue.'})*`,
                    }
                  : msg
              )
            );
          }
        }
      }
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
    } finally {
      setIsStreaming(false);
      setActiveToolPill(null);
    }
  };

  // HITL Action Approval
  const approveAction = async (actionId) => {
    try {
      const res = await api.post('/copilot/action/approve', { actionId });

      // Update message card state
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.stagedAction?.actionId === actionId) {
            return {
              ...msg,
              stagedAction: {
                ...msg.stagedAction,
                status: 'APPROVED',
                result: res.data.data,
              },
            };
          }
          return msg;
        })
      );

      // Silently refresh profile balance and tickets live
      await Promise.all([fetchLeaveBalance(), fetchTickets()]);
      setNotificationsCount((c) => c + 1);
      return res.data;
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      alert(`Approval Failed: ${msg}`);
      throw err;
    }
  };

  // HITL Action Rejection
  const rejectAction = async (actionId) => {
    try {
      const res = await api.post('/copilot/action/reject', { actionId });

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
      return res.data;
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      alert(`Rejection Failed: ${msg}`);
      throw err;
    }
  };

  // Direct Ticket Creation
  const createNewTicket = async ({ title, description, category, priority }) => {
    const res = await api.post('/tickets', { title, description, category, priority });
    await fetchTickets();
    setNotificationsCount((c) => c + 1);
    return res.data;
  };

  // Policy Document Upload
  const uploadPolicyDocument = async (file, department) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('department', department || user?.department || 'GENERAL');

    const res = await api.post('/copilot/documents', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
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
        // Citations
        citationsList,
        selectedCitation,
        isCitationDrawerOpen,
        openCitation,
        closeCitationDrawer,
        // Ops & Actions
        leaveBalance,
        tickets,
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
