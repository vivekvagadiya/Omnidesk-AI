import { apiClient } from './apiClient';

/**
 * Profile & Balance Service
 * Communicates with /api/profile endpoints
 */
export const profileService = {
  /**
   * Fetch current user leave quotas and balance
   */
  async getLeaveBalance({ signal } = {}) {
    const response = await apiClient.get('/profile/balance', { signal });
    return response.data.data;
  },
};
