/**
 * Query key factory — the single source of truth for cache keys.
 *
 * Keys include the userId so one user's cached data can never be read by
 * another user who signs in on the same browser. Invalidate by prefix:
 *
 *   queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all })
 */
export const queryKeys = {
  auth: {
    all: ['auth'],
    me: (userId) => ['auth', 'me', userId],
  },
  profile: {
    all: ['profile'],
    balance: (userId) => ['profile', 'balance', userId],
  },
  notifications: {
    all: ['notifications'],
    unreadCount: (userId) => ['notifications', 'unread', userId],
    lists: () => ['notifications', 'list'],
    list: (userId) => ['notifications', 'list', userId],
  },
  tickets: {
    all: ['tickets'],
    lists: () => ['tickets', 'list'],
    list: (userId, filters) => ['tickets', 'list', userId, filters],
  },
};
