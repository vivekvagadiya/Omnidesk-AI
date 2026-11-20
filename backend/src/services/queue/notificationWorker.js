import { getRedisClient } from '../../config/redis.js';

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

/**
 * Start the background notification worker consumer loop
 * Uses Redis BRPOP / brPop on queue:notifications, with fallback queue polling
 *
 * @param {Object} [options]
 * @param {number} [options.pollingIntervalMs=500] Poll interval when queue empty
 * @param {boolean} [options.useDedicatedClient=true] Clone Redis connection for blocking pop
 * @param {Function} [options.onDispatched] Event listener for tests/telemetry
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

  const mainRedis = getRedisClient();

  if (useDedicatedClient && mainRedis && mainRedis.isOpen && typeof mainRedis.duplicate === 'function') {
    try {
      workerDedicatedClient = mainRedis.duplicate();
      await workerDedicatedClient.connect();
    } catch (dupErr) {
      console.warn(`⚠️ [Notification Worker] Could not duplicate Redis client: ${dupErr.message}.`);
      workerDedicatedClient = null;
    }
  }

  (async () => {
    while (isWorkerRunning) {
      try {
        let rawMessage = null;

        const client = workerDedicatedClient || (mainRedis?.isOpen ? mainRedis : null);

        if (client && client.isOpen) {
          try {
            // brPop in node-redis v4 returns { key, element } or null after timeout
            const popResult = await client.brPop(NOTIFICATION_QUEUE_KEY, 1);
            if (popResult && popResult.element) {
              rawMessage = popResult.element;
            }
          } catch (redisErr) {
            if (!isWorkerRunning) break;
          }
        }

        // Check fallback in-memory queue
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
        } else {
          await new Promise((resolve) => setTimeout(resolve, pollingIntervalMs));
        }
      } catch (loopErr) {
        if (!isWorkerRunning) break;
        console.error('⚠️ [Notification Worker] Error in consumer loop:', loopErr.message);
        await new Promise((resolve) => setTimeout(resolve, 1000));
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
  if (workerDedicatedClient && workerDedicatedClient.isOpen) {
    try {
      await workerDedicatedClient.quit();
    } catch {
      // Ignore cleanup error
    }
    workerDedicatedClient = null;
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
