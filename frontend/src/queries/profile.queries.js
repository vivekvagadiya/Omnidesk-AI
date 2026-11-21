import { useQuery } from '@tanstack/react-query';
import { profileService } from '../services/profile.service';
import { useAuth } from '../context/AuthContext';
import { queryKeys } from './queryKeys';

/**
 * Current user's leave balances: { casual, sick, maternity }.
 * `data` is undefined until the first response — render a placeholder, not fake numbers.
 */
export function useLeaveBalanceQuery({ enabled = true } = {}) {
  const { user } = useAuth();

  return useQuery({
    queryKey: queryKeys.profile.balance(user?.userId),
    queryFn: profileService.getLeaveBalance,
    select: (data) => data?.leaveBalances ?? null,
    enabled: Boolean(user?.userId) && enabled,
    meta: { errorTitle: 'Could not refresh leave balance' },
  });
}
