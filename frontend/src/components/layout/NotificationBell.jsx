import React, { useEffect, useRef, useState } from 'react';
import {
  Bell,
  CalendarCheck,
  CalendarDays,
  CheckCheck,
  Inbox,
  Laptop,
  Loader2,
  Ticket,
  TicketPlus,
} from 'lucide-react';
import {
  useUnreadCountQuery,
  useNotificationsQuery,
  useNotificationSync,
  useMarkNotificationReadMutation,
  useMarkAllNotificationsReadMutation,
} from '../../queries';

const TYPE_STYLES = {
  TICKET_CREATED: { icon: Ticket, tone: 'text-blue-300 bg-blue-950/40 border-blue-900/60' },
  TICKET_ASSIGNED_QUEUE: { icon: TicketPlus, tone: 'text-orange-300 bg-orange-950/40 border-orange-900/60' },
  LEAVE_APPROVED: { icon: CalendarCheck, tone: 'text-emerald-300 bg-emerald-950/40 border-emerald-900/60' },
  TEAM_LEAVE_APPROVED: { icon: CalendarDays, tone: 'text-amber-300 bg-amber-950/40 border-amber-900/60' },
  HARDWARE_REQUESTED: { icon: Laptop, tone: 'text-blue-300 bg-blue-950/40 border-blue-900/60' },
  HARDWARE_QUEUE: { icon: Laptop, tone: 'text-orange-300 bg-orange-950/40 border-orange-900/60' },
};

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function timeAgo(isoDate) {
  const seconds = Math.round((new Date(isoDate).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86400) return rtf.format(Math.round(seconds / 86400), 'day');
  return new Date(isoDate).toLocaleDateString();
}

export function NotificationBell() {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  const { data: unread = 0 } = useUnreadCountQuery();
  useNotificationSync(unread);

  const listQuery = useNotificationsQuery({ enabled: isOpen });
  const markRead = useMarkNotificationReadMutation();
  const markAllRead = useMarkAllNotificationsReadMutation();

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  // Refresh the list each time the dropdown opens
  useEffect(() => {
    if (isOpen) listQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Close on outside click / Escape
  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setIsOpen(false);
    };
    const onKeyDown = (e) => e.key === 'Escape' && setIsOpen(false);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        title="Notifications"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className={`relative p-1.5 rounded-lg transition-colors border ${
          isOpen
            ? 'text-zinc-100 bg-zinc-800/70 border-zinc-700'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border-transparent hover:border-zinc-800'
        }`}
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-zinc-100 text-zinc-950 font-mono text-[10px] font-bold flex items-center justify-center border border-zinc-900">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full mt-2 w-80 z-50 bg-[#0f1118] border border-zinc-800 rounded-xl shadow-2xl overflow-hidden text-xs"
        >
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800">
            <span className="font-semibold text-zinc-100">Notifications</span>
            <button
              type="button"
              onClick={() => markAllRead.mutate()}
              disabled={unread === 0 || markAllRead.isPending}
              className="flex items-center gap-1 text-[10px] font-mono text-zinc-400 hover:text-zinc-100 disabled:opacity-40 disabled:hover:text-zinc-400 transition-colors"
            >
              <CheckCheck className="w-3.5 h-3.5" /> Mark all read
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {listQuery.isPending ? (
              <div className="flex items-center justify-center gap-2 py-8 text-zinc-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : listQuery.isError && items.length === 0 ? (
              <div className="py-6 px-4 text-center space-y-2">
                <div className="text-red-300">{listQuery.error.message}</div>
                <button
                  type="button"
                  onClick={() => listQuery.refetch()}
                  className="font-mono text-[10px] text-zinc-400 underline hover:text-zinc-200"
                >
                  Try again
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-zinc-500">
                <Inbox className="w-6 h-6" />
                <span>You're all caught up</span>
              </div>
            ) : (
              <ul className="divide-y divide-zinc-800/70">
                {items.map((n) => {
                  const style = TYPE_STYLES[n.type] || TYPE_STYLES.TICKET_CREATED;
                  const Icon = style.icon;
                  return (
                    <li key={n.notificationId}>
                      <button
                        type="button"
                        onClick={() => !n.read && markRead.mutate(n.notificationId)}
                        className={`w-full text-left flex gap-2.5 px-3 py-2.5 transition-colors hover:bg-zinc-800/40 ${
                          n.read ? 'opacity-60' : ''
                        }`}
                      >
                        <span
                          className={`mt-0.5 w-7 h-7 flex-shrink-0 rounded-lg border flex items-center justify-center ${style.tone}`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-start justify-between gap-2">
                            <span className="font-medium text-zinc-100 leading-snug">{n.title}</span>
                            {!n.read && <span className="mt-1 w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />}
                          </span>
                          {n.body && <span className="block text-zinc-400 mt-0.5 truncate">{n.body}</span>}
                          <span className="block text-[10px] font-mono text-zinc-500 mt-1">{timeAgo(n.createdAt)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {listQuery.hasNextPage && (
            <button
              type="button"
              onClick={() => listQuery.fetchNextPage()}
              disabled={listQuery.isFetchingNextPage}
              className="w-full py-2 border-t border-zinc-800 text-[10px] font-mono text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/40 transition-colors disabled:opacity-50"
            >
              {listQuery.isFetchingNextPage ? 'Loading…' : 'Load older'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
