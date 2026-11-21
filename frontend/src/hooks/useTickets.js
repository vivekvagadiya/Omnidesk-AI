import { useState } from 'react';
import { useTicketsQuery, useCreateTicketMutation } from '../queries';

/**
 * @deprecated Use useTicketsQuery / useCreateTicketMutation from 'src/queries' directly.
 * Kept as a thin wrapper so older imports keep working.
 */
export function useTickets({ initialScope = 'mine', autoFetch = true } = {}) {
  const [ticketScope, setTicketScope] = useState(initialScope);
  const query = useTicketsQuery({ scope: ticketScope, enabled: autoFetch });
  const createMutation = useCreateTicketMutation();

  return {
    tickets: query.data?.tickets ?? [],
    ticketScope,
    setTicketScope,
    isLoading: query.isFetching || createMutation.isPending,
    error: query.error?.message || createMutation.error?.message || null,
    fetchTickets: query.refetch,
    createTicket: createMutation.mutateAsync,
  };
}
