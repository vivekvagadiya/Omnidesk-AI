import { useLeaveBalanceQuery } from '../queries';

/**
 * @deprecated Use useLeaveBalanceQuery from 'src/queries' directly.
 * Kept as a thin wrapper so older imports keep working.
 */
export function useLeaveBalance({ autoFetch = true } = {}) {
  const query = useLeaveBalanceQuery({ enabled: autoFetch });

  return {
    leaveBalance: query.data ?? null,
    isLoading: query.isFetching,
    error: query.error?.message || null,
    fetchLeaveBalance: query.refetch,
  };
}
