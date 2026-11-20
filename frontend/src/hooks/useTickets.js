import { useState, useCallback, useEffect } from 'react';
import { ticketService } from '../services';

/**
 * Custom React Hook: Manage Support Tickets
 * Handles scope filtering ('mine' | 'all'), live loading state, and ticket creation
 */
export function useTickets({ user, initialScope = 'mine', autoFetch = true } = {}) {
  const [tickets, setTickets] = useState([]);
  const [ticketScope, setTicketScope] = useState(initialScope);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchTickets = useCallback(
    async (scope = ticketScope) => {
      if (!user) return [];
      setIsLoading(true);
      setError(null);
      try {
        const isManagerOrAdmin = ['manager', 'org_admin', 'super_admin', 'hr_admin', 'it_admin'].includes(
          user?.role
        );
        const params = { limit: 25 };
        if (!isManagerOrAdmin || scope !== 'all') {
          params.userId = user.userId;
        }

        const data = await ticketService.getTickets(params);
        const list = data?.tickets || [];
        setTickets(list);
        return list;
      } catch (err) {
        const msg = err.response?.data?.message || err.message || 'Failed to fetch tickets';
        setError(msg);
        return [];
      } finally {
        setIsLoading(false);
      }
    },
    [user, ticketScope]
  );

  const createTicket = useCallback(
    async ({ title, description, category, priority }) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await ticketService.createTicket({ title, description, category, priority });
        await fetchTickets(ticketScope);
        return result;
      } catch (err) {
        const msg = err.response?.data?.message || err.message || 'Failed to create ticket';
        setError(msg);
        throw new Error(msg);
      } finally {
        setIsLoading(false);
      }
    },
    [fetchTickets, ticketScope]
  );

  useEffect(() => {
    if (autoFetch && user) {
      fetchTickets(ticketScope);
    }
  }, [autoFetch, user, ticketScope, fetchTickets]);

  return {
    tickets,
    ticketScope,
    setTicketScope,
    isLoading,
    error,
    fetchTickets,
    createTicket,
  };
}
