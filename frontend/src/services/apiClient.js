import axios from 'axios';
import { ApiError, toApiError, apiErrorFromResponse } from './apiError';
import {
  getStoredAccessToken,
  getStoredRefreshToken,
  setStoredSession,
  clearStoredSession,
} from './tokenStorage';

// Re-exported so existing imports from './apiClient' keep working
export {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  USER_KEY,
  getStoredAccessToken,
  getStoredRefreshToken,
  getStoredUser,
  setStoredSession,
  clearStoredSession,
} from './tokenStorage';
export { ApiError } from './apiError';

/**
 * API base URL. Defaults to '/api' (proxied to the backend by Vite in dev).
 * Set VITE_API_BASE_URL in frontend/.env when the API lives on another origin.
 */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

export const DEFAULT_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

export const SESSION_EXPIRED_EVENT = 'omnidesk:session_expired';

/**
 * Singleton axios client. Every call resolves with the axios response or rejects
 * with an ApiError (never a raw AxiosError).
 */
export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: DEFAULT_TIMEOUT_MS,
  headers: {
    Accept: 'application/json',
  },
});

// Auth endpoints that must never trigger a refresh-and-retry loop
const NO_REFRESH_PATHS = ['/auth/login', '/auth/register', '/auth/refresh'];
const isNoRefreshPath = (url = '') => NO_REFRESH_PATHS.some((p) => url.includes(p));

// -------------------------------------------------------------
// Token refresh — single flight shared by axios AND fetch (SSE)
// -------------------------------------------------------------
let refreshPromise = null;

function expireSession() {
  clearStoredSession();
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/**
 * Rotate the refresh token. Concurrent callers share one network request,
 * so ten requests failing with 401 at once cause exactly one /auth/refresh.
 *
 * @returns {Promise<string>} New access token
 */
export function refreshSession() {
  if (refreshPromise) return refreshPromise;

  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) {
    expireSession();
    return Promise.reject(new ApiError('Your session has expired. Please sign in again.', { status: 401 }));
  }

  refreshPromise = axios
    .post(`${API_BASE_URL}/auth/refresh`, { refreshToken }, { timeout: DEFAULT_TIMEOUT_MS })
    .then(({ data }) => {
      const { accessToken, refreshToken: rotated } = data.data;
      setStoredSession({ accessToken, refreshToken: rotated });
      return accessToken;
    })
    .catch((err) => {
      const apiError = toApiError(err);
      // Only a rejected refresh token ends the session; a network blip should not log the user out
      if (apiError.status === 401 || apiError.status === 403 || apiError.status === 400) {
        expireSession();
      }
      throw apiError;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

// -------------------------------------------------------------
// Request interceptor: attach the current access token
// -------------------------------------------------------------
apiClient.interceptors.request.use((config) => {
  const token = getStoredAccessToken();
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// -------------------------------------------------------------
// Response interceptor: refresh once on 401, normalize every error
// -------------------------------------------------------------
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !isNoRefreshPath(originalRequest.url)
    ) {
      originalRequest._retry = true;
      try {
        const newToken = await refreshSession();
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(originalRequest);
      } catch (refreshError) {
        return Promise.reject(toApiError(refreshError));
      }
    }

    return Promise.reject(toApiError(error));
  }
);

/**
 * fetch() with the same base URL, auth header and refresh-on-401 behaviour as apiClient.
 * Used for streaming responses (SSE), which axios cannot consume incrementally.
 * Resolves with the Response when ok, otherwise rejects with an ApiError.
 */
export async function authenticatedFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `${API_BASE_URL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  const send = (token) =>
    fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

  let response;
  try {
    response = await send(getStoredAccessToken());
    if (response.status === 401) {
      const newToken = await refreshSession();
      response = await send(newToken);
    }
  } catch (err) {
    throw toApiError(err);
  }

  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }
  return response;
}
