import { apiClient } from './apiClient';

/**
 * Hardware Asset Service
 * Interacts with /api/assets
 */
export const assetService = {
  /**
   * List hardware assets with optional filters (type, status, assignedTo)
   */
  async getAssets(params = {}, { signal } = {}) {
    const response = await apiClient.get('/assets', { params, signal });
    return response.data.data;
  },

  /**
   * Get single asset metadata
   */
  async getAssetByTag(assetTag, { signal } = {}) {
    const response = await apiClient.get(`/assets/${assetTag}`, { signal });
    return response.data.data;
  },

  /**
   * Update asset status, assignment, or specifications (IT Admin)
   */
  async updateAsset(assetTag, updates) {
    const response = await apiClient.patch(`/assets/${assetTag}`, updates);
    return response.data.data;
  },
};
