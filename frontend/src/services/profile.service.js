import { apiClient } from './apiClient';

/**
 * Profile & Balance Service
 * Communicates with /api/profile endpoints
 */
export const profileService = {
  /**
   * Fetch current user leave quotas and balance
   */
  async getLeaveBalance() {
    const response = await apiClient.get('/profile/balance');
    return response.data.data;
  },
};
