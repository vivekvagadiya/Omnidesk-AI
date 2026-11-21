import { apiClient } from './apiClient';

/**
 * Authentication Service
 * Communicates with /api/auth endpoints
 */
export const authService = {
  /**
   * Log in with corporate email and password
   */
  async login({ email, password }) {
    const response = await apiClient.post('/auth/login', { email, password });
    return response.data.data;
  },

  /**
   * Register a new corporate employee or administrator
   */
  async register(userData) {
    const response = await apiClient.post('/auth/register', userData);
    return response.data.data;
  },

  /**
   * Rotate refresh token to obtain a fresh access token
   */
  async refreshToken(refreshToken) {
    const response = await apiClient.post('/auth/refresh', { refreshToken });
    return response.data.data;
  },

  /**
   * Invalidate tokens and log out
   */
  async logout() {
    const response = await apiClient.post('/auth/logout');
    return response.data;
  },

  /**
   * Fetch current authenticated user profile
   */
  async getMe({ signal } = {}) {
    const response = await apiClient.get('/auth/me', { signal });
    return response.data.data?.user ?? null;
  },
};
