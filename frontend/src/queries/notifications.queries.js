import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationService } from '../services/notification.service';
import { useAuth } from '../context/AuthContext';
import { queryKeys } from './queryKeys';

/** Phase 1 delivery: poll the (Redis-cached) unread count. Phase 2 swaps this for SSE push. */
export const NOTIFICATION_POLL_MS = 30_000;

/**
 * Badge counter. Polls every 30s while the tab is visible.
 */
export function useUnreadCountQuery() {
  const { user } = useAuth();

  return useQuery({
    queryKey: queryKeys.notifications.unreadCount(user?.userId),
    queryFn: notificationService.getUnreadCount,
    enabled: Boolean(user?.userId),
    refetchInterval: NOTIFICATION_POLL_MS,
    refetchIntervalInBackground: false, // hidden tabs don't poll
    staleTime: 10_000,
  });
}

/**
 * Bell dropdown list with "load more". Only fetched while the dropdown is open.
 */
export function useNotificationsQuery({ enabled = true } = {}) {
  const { user } = useAuth();

  return useInfiniteQuery({
    queryKey: queryKeys.notifications.list(user?.userId),
    queryFn: ({ pageParam, signal }) => notificationService.list({ cursor: pageParam }, { signal }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    enabled: Boolean(user?.userId) && enabled,
    staleTime: 10_000,
  });
}

/**
 * When the unread count goes UP, something happened that may also have changed
 * tickets or balances (e.g. Sarah's leave was approved → David's team view).
 * Refresh those so other users' actions show up without a reload.
 */
export function useNotificationSync(unreadCount) {
  const queryClient = useQueryClient();
  const previous = useRef(unreadCount);

  useEffect(() => {
    if (unreadCount === undefined) return;
    if (previous.current !== undefined && unreadCount > previous.current) {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.profile.all });
    }
    previous.current = unreadCount;
  }, [unreadCount, queryClient]);
}

// ---------------------------------------------------------------------------
// Optimistic read mutations: badge and list update instantly, roll back on error
// ---------------------------------------------------------------------------

function useOptimisticRead(mutationFn, applyToItem, countDelta) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const countKey = queryKeys.notifications.unreadCount(user?.userId);
  const listKey = queryKeys.notifications.list(user?.userId);

  return useMutation({
    mutationFn,
    onMutate: async (variables) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: countKey }),
        queryClient.cancelQueries({ queryKey: listKey }),
      ]);
      const previousCount = queryClient.getQueryData(countKey);
      const previousList = queryClient.getQueryData(listKey);

      let changed = 0;
      if (previousList) {
        queryClient.setQueryData(listKey, {
          ...previousList,
          pages: previousList.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => {
              if (!item.read && applyToItem(item, variables)) {
                changed++;
                return { ...item, read: true, readAt: new Date().toISOString() };
              }
              return item;
            }),
          })),
        });
      }
      if (typeof previousCount === 'number') {
        queryClient.setQueryData(countKey, Math.max(0, previousCount - countDelta(changed, previousCount)));
      }
      return { previousCount, previousList };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousList) queryClient.setQueryData(listKey, context.previousList);
      if (context?.previousCount !== undefined) queryClient.setQueryData(countKey, context.previousCount);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: countKey }),
    meta: { errorTitle: 'Could not update notifications' },
  });
}

export function useMarkNotificationReadMutation() {
  return useOptimisticRead(
    (notificationId) => notificationService.markRead(notificationId),
    (item, notificationId) => item.notificationId === notificationId,
    (changed) => changed
  );
}

export function useMarkAllNotificationsReadMutation() {
  return useOptimisticRead(
    () => notificationService.markAllRead(),
    () => true,
    (_changed, previousCount) => previousCount // everything is read now
  );
}
