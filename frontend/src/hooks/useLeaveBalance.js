import { useState, useCallback, useEffect } from 'react';
import { profileService } from '../services';

/**
 * Custom React Hook: Manage Employee Leave Balance & Quotas
 * Fetches and synchronizes casual, sick, and maternity leave quotas
 */
export function useLeaveBalance({ user, autoFetch = true } = {}) {
  const [leaveBalance, setLeaveBalance] = useState({ casual: 12, sick: 7, maternity: 90 });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchLeaveBalance = useCallback(async () => {
    if (!user) return null;
    setIsLoading(true);
    setError(null);
    try {
      const data = await profileService.getLeaveBalance();
      if (data?.leaveBalances) {
        setLeaveBalance(data.leaveBalances);
        return data.leaveBalances;
      }
      return null;
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Failed to fetch leave balance';
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (autoFetch && user) {
      fetchLeaveBalance();
    }
  }, [autoFetch, user, fetchLeaveBalance]);

  return {
    leaveBalance,
    setLeaveBalance,
    isLoading,
    error,
    fetchLeaveBalance,
  };
}
