import { getRedisClient, createDedicatedClient, closeClient } from '../../config/redis.js';

export const NOTIFICATION_QUEUE_KEY = 'queue:notifications';

// In-memory fallback queue for offline or test environments
const inMemoryQueue = [];

/**
 * Push notification event to Redis queue or in-memory fallback
 *
 * @param {Object|string} payload Event payload
 * @param {Object} [client] Redis client
 */
export async function enqueueNotification(payload, client = getRedisClient()) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);

  if (client && client.isOpen) {
    try {
      // Fails fast while Redis is reconnecting (offline queue disabled) → memory fallback below
      await client.lPush(NOTIFICATION_QUEUE_KEY, serialized);
      return true;
    } catch (err) {
      console.warn(`⚠️ [Notification Queue] Redis lPush error: ${err.message}. Using fallback queue.`);
    }
  }

  inMemoryQueue.push(serialized);
  return true;
}

/**
 * Simulates dispatching notification email/alert based on queue event
 *
 * @param {Object|string} payload Event payload
 * @returns {Object} Dispatch audit summary
 */
export function processNotification(payload) {
  const event = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const timestamp = event.createdAt || new Date().toISOString();

  switch (event.event) {
    case 'ACTION_APPROVED': {
      console.log('\n📧 ================= NOTIFICATION DISPATCHED =================');
      console.log(`⏰ Time      : ${timestamp}`);
      console.log(`🏢 Org       : ${event.orgId}`);
      console.log(`👤 User      : ${event.userId}`);
      console.log(`📌 Type      : ${event.type}`);
      console.log(`🎫 Action ID : ${event.actionId}`);
      console.log(`📝 Status    : CONFIRMED & COMMITTED`);
      if (event.type === 'APPLY_LEAVE') {
        console.log(`🌴 Details   : ${event.details?.daysDeducted ?? 'N/A'} day(s) deducted. Remaining: ${event.details?.remainingBalance ?? 'N/A'}`);
      } else if (event.type === 'REQUEST_HARDWARE_UPGRADE') {
        console.log(`💻 Details   : Hardware requested: ${event.details?.requestedDevice ?? 'N/A'}`);
      }
      console.log('=============================================================\n');
      break;
    }

    case 'TICKET_CREATED': {
      console.log('\n📧 ================= NOTIFICATION DISPATCHED =================');
      console.log(`⏰ Time      : ${timestamp}`);
      console.log(`🏢 Org       : ${event.orgId}`);
      console.log(`👤 User      : ${event.userId}`);
      console.log(`🎫 Ticket ID : ${event.ticketId}`);
      console.log(`🏷️  Category  : ${event.category} (${event.priority})`);
      console.log(`📌 Title     : "${event.title}"`);
      console.log('=============================================================\n');
      break;
    }

    default: {
      console.log('\n📧 ================= NOTIFICATION DISPATCHED =================');
      console.log(`⏰ Time      : ${timestamp}`);
      console.log(`📢 Event     : ${event.event || 'GENERIC_NOTIFICATION'}`);
      console.log(`📦 Payload   : ${JSON.stringify(event)}`);
      console.log('=============================================================\n');
    }
  }

  return {
    dispatched: true,
    event: event.event,
    timestamp,
    payload: event,
  };
}

let isWorkerRunning = false;
let workerDedicatedClient = null;
let workerLoopPromise = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pop one message without ever blocking a shared connection.
 *  - Dedicated client: BRPOP (waits up to 1s server-side, zero CPU while idle).
 *  - Shared client:    RPOP (non-blocking) — used only when a dedicated client is disabled.
 */
async function popMessage(useDedicatedClient) {
  if (useDedicatedClient) {
    if (workerDedicatedClient?.isReady) {
      const popResult = await workerDedicatedClient.brPop(NOTIFICATION_QUEUE_KEY, 1);
      return popResult?.element || null;
    }
    return null;
  }

  const shared = getRedisClient();
  if (shared?.isReady) {
    return shared.rPop(NOTIFICATION_QUEUE_KEY);
  }
  return null;
}

/**
 * Start the background notification worker consumer loop.
 *
 * Runs on its own Redis connection by default: BRPOP blocks the connection it runs on,
 * so running it on the shared client would stall every cache/session/HITL command
 * for up to a second per loop iteration.
 *
 * @param {Object} [options]
 * @param {number} [options.pollingIntervalMs=500] Sleep when nothing was dequeued
 * @param {boolean} [options.useDedicatedClient=true] false = non-blocking RPOP polling on the shared client
 * @param {Function} [options.onDispatched] Listener for tests/telemetry
 */
export async function startNotificationWorker({
  pollingIntervalMs = 500,
  useDedicatedClient = true,
  onDispatched = null,
} = {}) {
  if (isWorkerRunning) {
    return;
  }

  isWorkerRunning = true;
  console.log('👷 [Notification Worker] Worker started, listening on queue:notifications...');

  if (useDedicatedClient) {
    // Connects (and reconnects) in the background — no need for Redis to be up yet
    workerDedicatedClient = createDedicatedClient('worker');
  }

  workerLoopPromise = (async () => {
    while (isWorkerRunning) {
      try {
        let rawMessage = null;

        try {
          rawMessage = await popMessage(useDedicatedClient);
        } catch (redisErr) {
          if (!isWorkerRunning) break;
          // Connection dropped mid-command; the client reconnects on its own
        }

        // Drain anything queued in memory while Redis was unavailable
        if (!rawMessage && inMemoryQueue.length > 0) {
          rawMessage = inMemoryQueue.shift();
        }

        if (rawMessage) {
          const result = processNotification(rawMessage);
          if (typeof onDispatched === 'function') {
            try {
              onDispatched(result, rawMessage);
            } catch (dispatchErr) {
              console.error('⚠️ [Notification Worker] Listener error:', dispatchErr.message);
            }
          }
        } else if (!(useDedicatedClient && workerDedicatedClient?.isReady)) {
          // BRPOP already waited server-side; only sleep when we didn't block
          await sleep(pollingIntervalMs);
        }
      } catch (loopErr) {
        if (!isWorkerRunning) break;
        console.error('⚠️ [Notification Worker] Error in consumer loop:', loopErr.message);
        await sleep(1000);
      }
    }

    console.log('👷 [Notification Worker] Worker stopped.');
  })();
}

/**
 * Stop the background notification worker cleanly
 */
export async function stopNotificationWorker() {
  isWorkerRunning = false;
  if (workerDedicatedClient) {
    await closeClient(workerDedicatedClient);
    workerDedicatedClient = null;
  }
  if (workerLoopPromise) {
    await workerLoopPromise.catch(() => {});
    workerLoopPromise = null;
  }
}

/**
 * Inspect in-memory fallback queue (useful for unit tests)
 */
export function getInMemoryQueue() {
  return inMemoryQueue;
}

// Standalone execution support
if (process.argv[1] && process.argv[1].endsWith('notificationWorker.js')) {
  console.log('🚀 Running Notification Worker standalone...');
  startNotificationWorker();
}
