/**
 * Server-Sent Events (SSE) Streaming Utility for Express
 * Enables real-time streaming of tokens, tool calls, citations, and HITL action cards.
 */

/**
 * Initialize an HTTP response for Server-Sent Events (SSE) streaming
 *
 * @param {import('express').Response} res Express response object
 */
export function initSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable buffering on Nginx reverse proxy
  });

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

/**
 * Format and send a structured SSE event to the client
 *
 * @param {import('express').Response} res Express response object
 * @param {string} event Event name (e.g. 'token', 'tool_call', 'citation', 'action_required', 'done')
 * @param {Object|string} data Event payload object or string
 */
export function sendSSE(res, event, data) {
  if (res.writableEnded || res.closed) {
    return;
  }

  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);

  if (typeof res.flush === 'function') {
    res.flush();
  }
}

/**
 * Gracefully close the SSE connection
 *
 * @param {import('express').Response} res Express response object
 */
export function closeSSE(res) {
  if (!res.writableEnded && !res.closed) {
    res.end();
  }
}
