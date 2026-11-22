import { apiClient } from './apiClient';

/**
 * Audit Log & Telemetry Service
 * Interacts with /api/audit-logs
 */
export const auditService = {
  /**
   * List corporate audit logs with telemetry
   */
  async getAuditLogs(params = {}, { signal } = {}) {
    const response = await apiClient.get('/audit-logs', { params, signal });
    return response.data.data;
  },
};
