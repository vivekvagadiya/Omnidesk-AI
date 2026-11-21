/**
 * Route-level cache — integration test against a REAL Redis.
 *
 * The previous version replaced Redis with a mock and never asserted a cache HIT,
 * so it passed even while caching was broken. This one spins up a small Express app
 * with the real middleware and the real Redis from .env (docker compose up -d).
 *
 * Run: npm run test:cache
 */
import express from 'express';
import crypto from 'node:crypto';
import { connectRedis, disconnectRedis, getRedisClient, isRedisReady } from '../src/config/redis.js';
import { cacheResponse } from '../src/middlewares/cache.middleware.js';
import {
  cacheTags,
  invalidateTicketCaches,
  invalidateBalanceCaches,
  invalidateResourceForOrg,
} from '../src/services/cache/cache.service.js';
import {
  startNotificationWorker,
  stopNotificationWorker,
  enqueueNotification,
} from '../src/services/queue/notificationWorker.js';

let total = 0;
let passed = 0;
function assert(condition, description) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${description}`);
  } else {
    console.error(`  ❌ [FAIL] ${description}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unique tenant per run so reruns never see each other's keys
const ORG = `org_cachetest_${crypto.randomBytes(3).toString('hex')}`;
const OTHER_ORG = `${ORG}_other`;
const ADMIN_ROLES = ['org_admin'];

function buildApp() {
  const app = express();
  const calls = { balance: 0, tickets: 0 };
  const control = { balanceDelayMs: 0, ticketsDelayMs: 0, failNext: false };

  // Fake auth: identity comes from test headers
  app.use((req, _res, next) => {
    req.user = {
      orgId: req.headers['x-test-org'] || ORG,
      userId: req.headers['x-test-user'] || 'emp_1',
      role: req.headers['x-test-role'] || 'employee',
    };
    next();
  });

  app.get('/api/profile/balance', cacheResponse({ ttl: 60, tag: 'balance' }), async (req, res) => {
    calls.balance++;
    const n = calls.balance;
    if (control.balanceDelayMs) await sleep(control.balanceDelayMs);
    if (control.failNext) {
      control.failNext = false;
      return res.status(500).json({ success: false, message: 'boom' });
    }
    res.json({ success: true, data: { call: n, userId: req.user.userId } });
  });

  const ticketTags = (req) => {
    const { orgId, userId, role } = req.user;
    if (!ADMIN_ROLES.includes(role)) return [cacheTags.user('tickets', orgId, userId)];
    return [cacheTags.org('tickets', orgId)];
  };
  app.get(
    '/api/tickets',
    cacheResponse({ ttl: 60, tag: 'tickets', tags: ticketTags, query: ['status', 'page'] }),
    async (req, res) => {
      calls.tickets++;
      if (control.ticketsDelayMs) await sleep(control.ticketsDelayMs);
      res.json({ success: true, data: { call: calls.tickets } });
    }
  );

  return { app, calls, control };
}

async function run() {
  console.log('================================================================');
  console.log('🚀 OMNIDESK AI — ROUTE-LEVEL CACHE (REAL REDIS) VERIFICATION');
  console.log('================================================================\n');

  await connectRedis({ waitMs: 5000 });
  if (!isRedisReady()) {
    console.error('❌ Redis is not reachable. Start it first: docker compose up -d redis');
    process.exit(1);
  }

  const { app, calls, control } = buildApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async (path, { user = 'emp_1', org = ORG, role = 'employee', headers = {} } = {}) => {
    const r = await fetch(base + path, {
      headers: { 'x-test-user': user, 'x-test-org': org, 'x-test-role': role, ...headers },
    });
    return { status: r.status, cache: r.headers.get('x-cache'), body: await r.json() };
  };

  try {
    console.log('--- Suite 1: Miss then Hit ---');
    const a1 = await get('/api/profile/balance');
    const a2 = await get('/api/profile/balance');
    assert(a1.cache === 'MISS', 'First request is a MISS');
    assert(a2.cache === 'HIT', 'Second request is a HIT');
    assert(calls.balance === 1, 'Controller ran only once');
    assert(a2.body.data.call === 1, 'HIT returns the stored body');

    console.log('\n--- Suite 2: Isolation ---');
    const b1 = await get('/api/profile/balance', { user: 'emp_2' });
    const c1 = await get('/api/profile/balance', { org: OTHER_ORG });
    assert(b1.cache === 'MISS' && b1.body.data.userId === 'emp_2', 'Other user in same org gets their own entry');
    assert(c1.cache === 'MISS', 'Same userId in another org gets its own entry');
    const q1 = await get('/api/tickets?status=OPEN');
    const q2 = await get('/api/tickets?status=RESOLVED');
    assert(q1.cache === 'MISS' && q2.cache === 'MISS', 'Different query strings are cached separately');
    await get('/api/tickets?status=OPEN&page=2');
    assert((await get('/api/tickets?page=2&status=OPEN')).cache === 'HIT', 'Reordered params share one entry');
    const junk = await get('/api/tickets?junk=123');
    assert(junk.cache === 'UNCACHEABLE', 'Unknown query param is served uncached (no key created)');

    console.log('\n--- Suite 3: Browser no-cache header does NOT bypass ---');
    const d1 = await get('/api/profile/balance', { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } });
    assert(d1.cache === 'HIT', 'Chrome DevTools "Disable cache" headers still hit Redis');
    const d2 = await get('/api/profile/balance', { headers: { 'x-cache-bypass': '1' } });
    assert(d2.cache === 'BYPASS', 'Explicit X-Cache-Bypass: 1 bypasses (non-production)');

    console.log('\n--- Suite 4: Scoped invalidation ---');
    await get('/api/tickets', { user: 'emp_1' });
    await get('/api/tickets', { user: 'emp_2' });
    await get('/api/tickets', { user: 'admin_1', role: 'org_admin' });
    assert((await get('/api/tickets', { user: 'emp_1' })).cache === 'HIT', 'emp_1 tickets cached');

    await invalidateTicketCaches({ orgId: ORG, userId: 'emp_1' });
    assert((await get('/api/tickets', { user: 'emp_1' })).cache === 'MISS', 'emp_1 tickets refreshed after their ticket changed');
    assert((await get('/api/tickets', { user: 'emp_2' })).cache === 'HIT', 'emp_2 tickets untouched');
    assert(
      (await get('/api/tickets', { user: 'admin_1', role: 'org_admin' })).cache === 'MISS',
      'Admin org-wide ticket view refreshed'
    );

    await invalidateBalanceCaches({ orgId: ORG, userId: 'emp_1' });
    assert((await get('/api/profile/balance', { user: 'emp_1' })).cache === 'MISS', 'emp_1 balance refreshed after leave approval');
    assert((await get('/api/profile/balance', { user: 'emp_2' })).cache === 'HIT', 'emp_2 balance untouched');

    await invalidateResourceForOrg(ORG, 'balance');
    assert((await get('/api/profile/balance', { user: 'emp_2' })).cache === 'MISS', 'Org-wide flush clears every user');
    assert((await get('/api/profile/balance', { org: OTHER_ORG })).cache === 'HIT', 'Org-wide flush does not touch other tenants');

    console.log('\n--- Suite 5: Stale-write race ---');
    await invalidateBalanceCaches({ orgId: ORG, userId: 'emp_9' });
    control.balanceDelayMs = 300;
    const slow = get('/api/profile/balance', { user: 'emp_9' }); // reads "old" data
    await sleep(50);
    await invalidateBalanceCaches({ orgId: ORG, userId: 'emp_9' }); // mutation lands mid-request
    await slow;
    control.balanceDelayMs = 0;
    const after = await get('/api/profile/balance', { user: 'emp_9' });
    assert(after.cache === 'MISS', 'Slow pre-mutation response is not served after invalidation');

    console.log('\n--- Suite 6: Errors are never cached ---');
    control.failNext = true;
    await invalidateBalanceCaches({ orgId: ORG, userId: 'emp_err' });
    const e1 = await get('/api/profile/balance', { user: 'emp_err' });
    const e2 = await get('/api/profile/balance', { user: 'emp_err' });
    assert(e1.status === 500 && e2.status === 200 && e2.cache === 'MISS', '500 response was not stored');

    console.log('\n--- Suite 7: Stampede protection ---');
    control.ticketsDelayMs = 200;
    const before = calls.tickets;
    const burst = await Promise.all(Array.from({ length: 30 }, () => get('/api/tickets?status=CLOSED', { user: 'emp_burst' })));
    control.ticketsDelayMs = 0;
    assert(calls.tickets - before === 1, `30 concurrent cold requests ran the controller once (ran ${calls.tickets - before})`);
    assert(burst.filter((r) => r.cache === 'COALESCED').length === 29, '29 requests shared the in-flight response');

    console.log('\n--- Suite 8: Worker does not block the shared connection ---');
    const dispatched = [];
    await startNotificationWorker({ onDispatched: (r) => dispatched.push(r) });
    await sleep(300);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await getRedisClient().ping();
    const pingMs = Date.now() - t0;
    assert(pingMs < 200, `Shared client stays responsive while worker waits on BRPOP (${pingMs}ms for 5 pings)`);
    await enqueueNotification({ event: 'CACHE_TEST', orgId: ORG, createdAt: new Date().toISOString() });
    await sleep(1500);
    assert(dispatched.some((d) => d.event === 'CACHE_TEST'), 'Worker on dedicated connection consumed the event');
    await stopNotificationWorker();
  } finally {
    server.close();
    await disconnectRedis();
  }

  console.log('\n================================================================');
  console.log(`🎉 CACHE VERIFICATION: ${passed}/${total} TESTS PASSED`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
