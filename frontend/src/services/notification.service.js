import { apiClient } from "./apiClient";

/**
 * In-app notifications
 * Communicates with /api/notifications endpoints
 */
export const notificationService = {
  /**
   * Newest-first page. Pass the previous page's nextCursor to load more.
   * @returns {Promise<{ items: Object[], nextCursor: string|null }>}
   */
  async list({ cursor, limit = 20, unreadOnly = false } = {}, { signal } = {}) {
    const response = await apiClient.get("/notifications", {
      params: {
        cursor: cursor || undefined,
        limit,
        unread: unreadOnly || undefined,
      },
      signal,
    });
    return response.data.data;
  },

  /** @returns {Promise<number>} */
  async getUnreadCount({ signal } = {}) {
    const response = await apiClient.get("/notifications/unread-count", {
      signal,
    });
    return response.data.data?.unread ?? 0;
  },

  async markRead(notificationId) {
    const response = await apiClient.patch(
      `/notifications/${encodeURIComponent(notificationId)}/read`,
    );
    return response.data.data;
  },

  async markAllRead() {
    const response = await apiClient.post("/notifications/read-all");
    return response.data.data;
  },
};
