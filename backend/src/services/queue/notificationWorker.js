/**
 * Notification Worker (Deprecated)
 *
 * In-app notifications in MongoDB are the sole source of truth and are handled
 * directly via `notify()` in `notification.service.js`.
 *
 * The background worker that previously simulated console dispatches has been retired
 * to avoid duplicate notification processing paths.
 */

export const NOTIFICATION_QUEUE_KEY = 'queue:notifications';

/**
 * @deprecated Use `notify()` from `notification.service.js` instead.
 */
export async function enqueueNotification() {
  return true;
}

/**
 * @deprecated Simulated notification dispatch has been removed.
 */
export function processNotification(payload) {
  const event = typeof payload === 'string' ? JSON.parse(payload) : payload;
  return {
    dispatched: false,
    event: event?.event,
    timestamp: event?.createdAt || new Date().toISOString(),
    payload: event,
  };
}

/**
 * @deprecated Background worker consumer loop has been retired.
 */
export async function startNotificationWorker() {
  // No-op: in-app notifications are persisted directly via notify()
}

/**
 * @deprecated Background worker consumer loop has been retired.
 */
export async function stopNotificationWorker() {
  // No-op
}

export function getInMemoryQueue() {
  return [];
}
