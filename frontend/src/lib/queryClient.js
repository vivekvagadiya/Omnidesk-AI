import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { toast } from 'sonner';
import { toApiError } from '../services/apiError';

/**
 * Shared QueryClient.
 *
 * Error toasts are opt-in per query/mutation via `meta.errorTitle`, so a form that
 * shows its own inline error doesn't also pop a toast.
 *
 *   useMutation({ mutationFn, meta: { errorTitle: 'Approval failed' } })
 */

const MAX_RETRIES = 2;

function shouldRetry(failureCount, error) {
  // Never retry 4xx (bad input, forbidden, not found, expired session)
  return failureCount < MAX_RETRIES && toApiError(error).isRetryable;
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      // Background refetch failures for data already on screen get a toast;
      // first-load failures are shown inline by the component.
      if (query.meta?.errorTitle && query.state.data !== undefined) {
        toast.error(query.meta.errorTitle, { description: toApiError(error).message });
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.errorTitle) {
        toast.error(mutation.meta.errorTitle, { description: toApiError(error).message });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000, // treat data as fresh for 30s — the backend Redis cache absorbs refetches
      gcTime: 5 * 60_000,
      retry: shouldRetry,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: false, // mutations are not idempotent (leave approval, ticket creation)
    },
  },
});
