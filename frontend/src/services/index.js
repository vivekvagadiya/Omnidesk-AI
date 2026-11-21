export {
  apiClient,
  apiClient as api, // Alias for backwards compatibility
  API_BASE_URL,
  SESSION_EXPIRED_EVENT,
  refreshSession,
  authenticatedFetch,
} from './apiClient';
export { ApiError, toApiError } from './apiError';
export {
  getStoredAccessToken,
  getStoredRefreshToken,
  getStoredUser,
  setStoredSession,
  clearStoredSession,
} from './tokenStorage';

export { authService } from './auth.service';
export { copilotService } from './copilot.service';
export { ticketService } from './ticket.service';
export { profileService } from './profile.service';
