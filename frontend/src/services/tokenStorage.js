/**
 * Session token storage.
 *
 * "Remember me" sessions live in localStorage, others in sessionStorage.
 * Refreshing tokens writes back to whichever storage already holds the session
 * (previously a refresh always wrote to localStorage, silently turning a
 * session-only login into a persistent one).
 */

export const ACCESS_TOKEN_KEY = 'omnidesk_access_token';
export const REFRESH_TOKEN_KEY = 'omnidesk_refresh_token';
export const USER_KEY = 'omnidesk_user';

function read(key) {
  return localStorage.getItem(key) || sessionStorage.getItem(key);
}

function activeStorage() {
  return sessionStorage.getItem(REFRESH_TOKEN_KEY) && !localStorage.getItem(REFRESH_TOKEN_KEY)
    ? sessionStorage
    : localStorage;
}

export function getStoredAccessToken() {
  return read(ACCESS_TOKEN_KEY);
}

export function getStoredRefreshToken() {
  return read(REFRESH_TOKEN_KEY);
}

export function getStoredUser() {
  try {
    const raw = read(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * @param {Object} session
 * @param {string} [session.accessToken]
 * @param {string} [session.refreshToken]
 * @param {Object} [session.user]
 * @param {boolean} [session.rememberMe] Only pass on login; omit on refresh to keep the current storage
 */
export function setStoredSession({ accessToken, refreshToken, user, rememberMe }) {
  let storage = activeStorage();
  if (rememberMe !== undefined) {
    clearStoredSession();
    storage = rememberMe ? localStorage : sessionStorage;
  }
  if (accessToken) storage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) storage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  if (user) storage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredSession() {
  for (const storage of [localStorage, sessionStorage]) {
    storage.removeItem(ACCESS_TOKEN_KEY);
    storage.removeItem(REFRESH_TOKEN_KEY);
    storage.removeItem(USER_KEY);
  }
}
