import { apiClient } from './apiClient';

/**
 * Cryptographic Audit Log & Telemetry Service
 * Interacts with /api/audit-logs
 */
export const auditService = {
  /**
   * List immutable SHA-256 audit logs with telemetry
   */
  async getAuditLogs(params = {}, { signal } = {}) {
    const response = await apiClient.get('/audit-logs', { params, signal });
    return response.data.data;
  },

  /**
   * Verify cryptographic SHA-256 hash chaining integrity
   */
  async verifyChain({ signal } = {}) {
    const response = await apiClient.get('/audit-logs/verify', { signal });
    return response.data.data;
  },
};
