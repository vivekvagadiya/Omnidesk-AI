import { apiClient, authenticatedFetch } from './apiClient';

/**
 * Copilot Service
 * Encapsulates SSE streaming, consequential action confirmation, and policy document ingestion
 */
export const copilotService = {
  /**
   * Stream a conversational copilot turn via Server-Sent Events (SSE)
   *
   * @param {Object} params
   * @param {string} params.message User prompt message
   * @param {string} params.sessionId Active Redis session key
   * @param {Function} params.onEvent Callback invoked on each SSE event (tool_call, token, citation, action_required, done, error)
   * @param {AbortSignal} [params.signal] AbortController signal
   */
  async streamChat({ message, sessionId, onEvent, signal }) {
    const response = await authenticatedFetch('/copilot/chat', {
      method: 'POST',
      body: JSON.stringify({ message, sessionId }),
      signal,
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
      buffer = lines.pop(); // Keep partial remainder in buffer

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

        if (onEvent) {
          onEvent(event, payload);
        }
      }
    }
  },

  /**
   * Approve and execute a staged Human-in-the-Loop consequential action
   */
  async approveAction(actionId) {
    const response = await apiClient.post('/copilot/action/approve', { actionId });
    return response.data;
  },

  /**
   * Reject and cancel a staged Human-in-the-Loop action
   */
  async rejectAction(actionId) {
    const response = await apiClient.post('/copilot/action/reject', { actionId });
    return response.data;
  },

  /**
   * Inspect details of a staged action
   */
  async getActionDetails(actionId) {
    const response = await apiClient.get(`/copilot/action/${actionId}`);
    return response.data.data;
  },

  /**
   * Upload and ingest policy document (PDF/MD/TXT) into Qdrant
   */
  async uploadDocument(file, department, allowedRoles = null) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('department', department || 'GENERAL');

    if (allowedRoles) {
      formData.append(
        'allowedRoles',
        Array.isArray(allowedRoles) ? JSON.stringify(allowedRoles) : allowedRoles
      );
    }

    const response = await apiClient.post('/copilot/documents', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    return response.data;
  },
};
