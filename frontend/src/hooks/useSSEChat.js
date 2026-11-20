import { useState, useRef, useCallback } from 'react';
import { copilotService } from '../services';

/**
 * Custom React Hook: Consume Server-Sent Events (SSE) from POST /api/copilot/chat
 * Emits structured events: 'tool_call', 'token', 'citation', 'action_required', 'done', 'error'
 */
export function useSSEChat({
  sessionId,
  onToolCall,
  onToken,
  onCitation,
  onActionRequired,
  onDone,
  onError,
} = {}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeToolPill, setActiveToolPill] = useState(null);
  const abortControllerRef = useRef(null);

  const streamChatTurn = useCallback(
    async (rawMessage) => {
      const text = rawMessage?.trim();
      if (!text || isStreaming) return;

      setIsStreaming(true);
      setActiveToolPill(null);

      abortControllerRef.current = new AbortController();

      try {
        await copilotService.streamChat({
          message: text,
          sessionId,
          signal: abortControllerRef.current.signal,
          onEvent: (event, payload) => {
            switch (event) {
              case 'tool_call': {
                const pillData = {
                  tool: payload.tool,
                  status: payload.status,
                  pill: payload.statusPill,
                };
                setActiveToolPill(pillData);
                if (onToolCall) onToolCall(pillData);
                break;
              }

              case 'token': {
                if (onToken) onToken(payload.delta || '');
                break;
              }

              case 'citation': {
                if (onCitation) onCitation(payload);
                break;
              }

              case 'action_required': {
                if (onActionRequired) onActionRequired(payload);
                break;
              }

              case 'done': {
                setActiveToolPill(null);
                if (onDone) onDone(payload);
                break;
              }

              case 'error': {
                if (onError) onError(payload);
                break;
              }

              default:
                break;
            }
          },
        });
      } catch (err) {
        if (err.name === 'AbortError') {
          console.log('SSE Stream cancelled by user');
        } else {
          if (onError) onError({ message: err.message });
        }
      } finally {
        setIsStreaming(false);
        setActiveToolPill(null);
        abortControllerRef.current = null;
      }
    },
    [
      sessionId,
      isStreaming,
      onToolCall,
      onToken,
      onCitation,
      onActionRequired,
      onDone,
      onError,
    ]
  );

  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  return {
    streamChatTurn,
    isStreaming,
    activeToolPill,
    abortStream,
  };
}
