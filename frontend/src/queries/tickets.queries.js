import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ticketService } from '../services/ticket.service';
import { useAuth } from '../context/AuthContext';
import { queryKeys } from './queryKeys';

export const TICKET_SCOPE_ROLES = ['manager', 'org_admin', 'super_admin', 'hr_admin', 'it_admin'];

/**
 * Ticket list for the signed-in user.
 *
 * @param {Object} [options]
 * @param {'mine'|'all'} [options.scope='mine'] 'all' is honoured for managers/admins only
 * @param {number} [options.limit=25]
 * @returns TanStack query result; `data` is { tickets, pagination }
 */
export function useTicketsQuery({ scope = 'mine', limit = 25, enabled = true } = {}) {
  const { user } = useAuth();
  const canSeeAll = TICKET_SCOPE_ROLES.includes(user?.role);

  const filters = { limit };
  if (!canSeeAll || scope !== 'all') {
    filters.userId = user?.userId;
  }

  return useQuery({
    queryKey: queryKeys.tickets.list(user?.userId, filters),
    queryFn: ({ signal }) => ticketService.getTickets(filters, { signal }),
    enabled: Boolean(user?.userId) && enabled,
    // Keep showing the current list while switching My/Team scope
    placeholderData: keepPreviousData,
    meta: { errorTitle: 'Could not refresh tickets' },
  });
}

export function useCreateTicketMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ title, description, category, priority }) =>
      ticketService.createTicket({ title, description, category, priority }),
    onSuccess: (ticket, variables) => {
      toast.success('Support Ticket Created', {
        description: `Ticket ${ticket?.ticketId || ''} created under ${variables.category}.`,
      });
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
      ]);
    },
    // No errorTitle: the create-ticket form shows the error inline
  });
}
