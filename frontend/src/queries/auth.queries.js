import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authService } from '../services/auth.service';
import { queryKeys } from './queryKeys';

/**
 * Validates the stored session against the server and keeps the profile fresh
 * (role or department changes made by an admin show up without re-login).
 */
export function useMeQuery({ userId, enabled = true } = {}) {
  return useQuery({
    queryKey: queryKeys.auth.me(userId),
    queryFn: authService.getMe,
    enabled: Boolean(userId) && enabled,
    staleTime: 5 * 60_000,
  });
}

export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }) => authService.login({ email, password }),
    onSuccess: (data) => {
      // Fresh identity: drop anything cached for a previous user
      queryClient.clear();
      if (data?.user?.userId) {
        queryClient.setQueryData(queryKeys.auth.me(data.user.userId), data.user);
      }
    },
  });
}

export function useRegisterMutation() {
  return useMutation({
    mutationFn: (userData) => authService.register(userData),
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => authService.logout(),
    // Clear cached data whether or not the server call succeeded
    onSettled: () => queryClient.clear(),
  });
}
