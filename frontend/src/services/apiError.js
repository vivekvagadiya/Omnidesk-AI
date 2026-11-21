/**
 * One error shape for every API failure, whether it came from axios, fetch,
 * a timeout or a dropped connection. Components and TanStack Query read
 * `error.message` and `error.status` instead of digging into `err.response.data`.
 */
export class ApiError extends Error {
  /**
   * @param {string} message Human-readable message (backend `message` when available)
   * @param {Object} [options]
   * @param {number} [options.status] HTTP status, 0 for network/timeout errors
   * @param {string} [options.code] 'NETWORK_ERROR' | 'TIMEOUT' | 'CANCELLED' | 'HTTP_ERROR'
   * @param {*} [options.details] Backend `errors` payload (validation details)
   * @param {Object} [options.response] Original axios response (kept for backwards compatibility)
   */
  constructor(message, { status = 0, code = 'HTTP_ERROR', details = null, response = undefined } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.response = response;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isNetworkError() {
    return this.code === 'NETWORK_ERROR' || this.code === 'TIMEOUT';
  }

  /** 5xx and network failures are worth retrying; 4xx never are */
  get isRetryable() {
    return this.isNetworkError || this.status >= 500;
  }
}

const FALLBACK_MESSAGES = {
  400: 'The request was invalid.',
  401: 'Your session has expired. Please sign in again.',
  403: "You don't have permission to do that.",
  404: 'The requested resource was not found.',
  409: 'This conflicts with an existing record.',
  413: 'The file is too large.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'Something went wrong on the server.',
  503: 'The service is temporarily unavailable.',
};

/**
 * Convert anything thrown by axios/fetch into an ApiError.
 */
export function toApiError(error) {
  if (error instanceof ApiError) return error;

  // axios cancellation
  if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || error?.name === 'AbortError') {
    return new ApiError('Request was cancelled.', { code: 'CANCELLED' });
  }

  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
    return new ApiError('The server took too long to respond.', { code: 'TIMEOUT' });
  }

  const response = error?.response;
  if (response) {
    const body = response.data || {};
    const status = response.status;
    const message =
      (typeof body.message === 'string' && body.message) || FALLBACK_MESSAGES[status] || `Request failed (${status}).`;
    return new ApiError(message, { status, details: body.errors || null, response });
  }

  if (error?.request || error?.message === 'Network Error' || error instanceof TypeError) {
    return new ApiError('Cannot reach the server. Check your connection.', { code: 'NETWORK_ERROR' });
  }

  return new ApiError(error?.message || 'Unexpected error.');
}

/**
 * Build an ApiError from a failed fetch() Response (used by the SSE stream).
 */
export async function apiErrorFromResponse(response) {
  const body = await response.json().catch(() => ({}));
  return new ApiError(body.message || FALLBACK_MESSAGES[response.status] || `Request failed (${response.status}).`, {
    status: response.status,
    details: body.errors || null,
  });
}
