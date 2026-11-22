import { apiClient } from './apiClient';

/**
 * Ticket Management Service
 * Communicates with /api/tickets endpoints
 */
export const ticketService = {
  /**
   * List tickets with optional filters and pagination
   */
  async getTickets(params = {}, { signal } = {}) {
    const response = await apiClient.get('/tickets', { params, signal });
    return response.data.data;
  },

  /**
   * Create a new support ticket
   */
  async createTicket({ title, description, category, priority }) {
    const response = await apiClient.post('/tickets', {
      title,
      description,
      category,
      priority,
    });
    return response.data.data;
  },

  /**
   * Update an existing ticket status, priority, or assignment
   */
  async updateTicket(ticketId, updates) {
    const response = await apiClient.patch(`/tickets/${ticketId}`, updates);
    return response.data.data;
  },
};
