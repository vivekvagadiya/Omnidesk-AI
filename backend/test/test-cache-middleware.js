/**
 * Route-Level Cache — Verification Test Suite
 *
 * Verifies:
 *  - Cache Miss then Hit
 *  - Tenant and User Isolation
 *  - Versioned Tag Invalidation (User-level & Org-wide)
 *  - Stale-write race condition prevention
 *  - Stampede protection (request coalescing)
 *  - Error responses (500) and unwhitelisted queries are never cached
 *  - Sensitive headers ('private, no-store')
 *  - Redis outage resilience (fail-open with X-Cache: SKIP)
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
  console.log('🚀 OMNIDESK AI — REDIS CACHE IMPLEMENTATION VERIFICATION');
  console.log('================================================================\n');

  await connectRedis({ waitMs: 5000 });
  if (!isRedisReady()) {
    console.error('❌ Redis is not reachable. Ensure Redis is running on port 6380.');
    process.exit(1);
  }

  const { app, calls, control } = buildApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async (path, { user = 'emp_1', org = ORG, role = 'employee', headers = {} } = {}) => {
    const r = await fetch(base + path, {
      headers: { 'x-test-user': user, 'x-test-org': org, 'x-test-role': role, ...headers },
    });
    return {
      status: r.status,
      cache: r.headers.get('x-cache'),
      cacheControl: r.headers.get('cache-control'),
      body: await r.json(),
    };
  };

  try {
    console.log('--- Suite 1: Cache Miss then Cache Hit ---');
    const a1 = await get('/api/profile/balance');
    const a2 = await get('/api/profile/balance');
    assert(a1.cache === 'MISS', 'First request is a MISS');
    assert(a2.cache === 'HIT', 'Second request is a HIT');
    assert(calls.balance === 1, 'Controller ran only once on cache hit');
    assert(a2.body.data.call === 1, 'HIT returns the stored response body');

    console.log('\n--- Suite 2: Tenant & User Isolation ---');
    const b1 = await get('/api/profile/balance', { user: 'emp_2' });
    const c1 = await get('/api/profile/balance', { org: OTHER_ORG });
    assert(b1.cache === 'MISS' && b1.body.data.userId === 'emp_2', 'Different user in same org gets their own cache entry');
    assert(c1.cache === 'MISS', 'Same userId in a different org gets its own cache entry (Cross-tenant isolation)');
    assert(a1.cacheControl === 'private, no-store', 'Cache-Control header prevents downstream shared caching');

    const q1 = await get('/api/tickets?status=OPEN');
    const q2 = await get('/api/tickets?status=RESOLVED');
    assert(q1.cache === 'MISS' && q2.cache === 'MISS', 'Different whitelisted query strings are cached separately');
    await get('/api/tickets?status=OPEN&page=2');
    assert((await get('/api/tickets?page=2&status=OPEN')).cache === 'HIT', 'Reordered query params share one entry');
    const junk = await get('/api/tickets?unauthorizedFilter=123');
    assert(junk.cache === 'UNCACHEABLE', 'Unwhitelisted query param is served live without caching');

    console.log('\n--- Suite 3: Bypass & Browser Headers ---');
    const d1 = await get('/api/profile/balance', { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } });
    assert(d1.cache === 'HIT', 'Browser no-cache headers do not bypass Redis cache');
    const d2 = await get('/api/profile/balance', { headers: { 'x-cache-bypass': '1' } });
    assert(d2.cache === 'BYPASS', 'Explicit X-Cache-Bypass: 1 bypasses cache in non-production');

    console.log('\n--- Suite 4: Scoped Tag Invalidation ---');
    await get('/api/tickets', { user: 'emp_1' });
    await get('/api/tickets', { user: 'emp_2' });
    await get('/api/tickets', { user: 'admin_1', role: 'org_admin' });
    assert((await get('/api/tickets', { user: 'emp_1' })).cache === 'HIT', 'emp_1 tickets are cached');

    await invalidateTicketCaches({ orgId: ORG, userId: 'emp_1' });
    assert((await get('/api/tickets', { user: 'emp_1' })).cache === 'MISS', 'emp_1 tickets invalidated after ticket mutation');
    assert((await get('/api/tickets', { user: 'emp_2' })).cache === 'HIT', 'emp_2 tickets remain cached (isolated)');
    assert(
      (await get('/api/tickets', { user: 'admin_1', role: 'org_admin' })).cache === 'MISS',
      'Admin org-wide ticket view invalidated'
    );

    await invalidateBalanceCaches({ orgId: ORG, userId: 'emp_1' });
    assert((await get('/api/profile/balance', { user: 'emp_1' })).cache === 'MISS', 'emp_1 balance refreshed after leave mutation');
    assert((await get('/api/profile/balance', { user: 'emp_2' })).cache === 'HIT', 'emp_2 balance remains cached');

    await invalidateResourceForOrg(ORG, 'balance');
    assert((await get('/api/profile/balance', { user: 'emp_2' })).cache === 'MISS', 'Org-wide flush clears all users in that org');
    assert((await get('/api/profile/balance', { org: OTHER_ORG })).cache === 'HIT', 'Org-wide flush does not touch other tenants');

    console.log('\n--- Suite 5: Stale-Write Race Prevention ---');
    await invalidateBalanceCaches({ orgId: ORG, userId: 'emp_race' });
    control.balanceDelayMs = 300;
    const slowReq = get('/api/profile/balance', { user: 'emp_race' }); // reads old version
    await sleep(50);
    await invalidateBalanceCaches({ orgId: ORG, userId: 'emp_race' }); // mutation increments version tag
    await slowReq;
    control.balanceDelayMs = 0;
    const afterMutation = await get('/api/profile/balance', { user: 'emp_race' });
    assert(afterMutation.cache === 'MISS', 'Slow pre-mutation response under old version is never served post-invalidation');

    console.log('\n--- Suite 6: Error Responses Are Never Cached ---');
    control.failNext = true;
    await invalidateBalanceCaches({ orgId: ORG, userId: 'emp_err' });
    const errRes1 = await get('/api/profile/balance', { user: 'emp_err' });
    const errRes2 = await get('/api/profile/balance', { user: 'emp_err' });
    assert(errRes1.status === 500 && errRes2.status === 200 && errRes2.cache === 'MISS', '500 error response is never stored in cache');

    console.log('\n--- Suite 7: Request Coalescing (Stampede Protection) ---');
    control.ticketsDelayMs = 200;
    const initialCalls = calls.tickets;
    const burst = await Promise.all(Array.from({ length: 30 }, () => get('/api/tickets?status=CLOSED', { user: 'emp_burst' })));
    control.ticketsDelayMs = 0;
    assert(calls.tickets - initialCalls === 1, `30 concurrent requests ran the controller once (ran ${calls.tickets - initialCalls})`);
    assert(burst.filter((r) => r.cache === 'COALESCED').length === 29, '29 concurrent followers shared the in-flight leader response');

    console.log('\n--- Suite 8: Redis Outage Resilience (Fail-Open) ---');
    const redisClient = getRedisClient();
    const originalIsReady = redisClient.isReady;
    try {
      // Simulate Redis being offline / unavailable
      Object.defineProperty(redisClient, 'isReady', { value: false, configurable: true });
      const outageRes = await get('/api/profile/balance', { user: 'emp_outage' });
      assert(outageRes.status === 200, 'Endpoint returns HTTP 200 during Redis outage');
      assert(outageRes.cache === 'SKIP', 'Middleware sets X-Cache: SKIP when Redis is down');
      assert(outageRes.body.success === true, 'Live MongoDB data returned without error when cache is unavailable');
    } finally {
      Object.defineProperty(redisClient, 'isReady', { value: originalIsReady, configurable: true });
    }

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
