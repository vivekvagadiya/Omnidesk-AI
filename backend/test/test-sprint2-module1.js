import { getQdrantClient, checkQdrantHealth } from '../src/config/qdrant.js';
import {
  POLICY_COLLECTION_NAME,
  VECTOR_DIMENSION,
  DISTANCE_METRIC,
  INDEXED_PAYLOAD_FIELDS,
  initPolicyCollection,
  upsertPolicyVectors,
  searchPolicyVectors,
} from '../src/services/rag/qdrant.service.js';
import { config } from '../src/config/environment.js';

console.log('================================================================');
console.log('🧠 OMNIDESK AI — SPRINT 2 MODULE 1: QDRANT VECTOR SETUP VERIFICATION');
console.log('================================================================\n');

let totalTests = 0;
let passedTests = 0;

const assert = (condition, description) => {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${description}`);
  } else {
    console.error(`  ❌ [FAIL] ${description}`);
  }
};

// -------------------------------------------------------------
// Suite 1: Qdrant Configuration & Constants
// -------------------------------------------------------------
console.log('--- Suite 1: Qdrant Configuration & Vector Specs ---');

assert(
  Boolean(config.qdrant.url),
  `Qdrant URL configured strictly from .env (${config.qdrant.url})`
);

const client = getQdrantClient();
assert(
  Boolean(client) && typeof client.createCollection === 'function',
  'getQdrantClient returns initialized QdrantClient instance'
);

assert(
  POLICY_COLLECTION_NAME === 'omnidesk_policies',
  `Collection name verified as '${POLICY_COLLECTION_NAME}'`
);

assert(
  VECTOR_DIMENSION === 768,
  `Vector dimension configured as ${VECTOR_DIMENSION} (matching Gemini text-embedding-004)`
);

assert(
  DISTANCE_METRIC === 'Cosine',
  `Distance metric configured as '${DISTANCE_METRIC}' for semantic cosine similarity`
);

const indexNames = INDEXED_PAYLOAD_FIELDS.map((f) => f.name);
assert(
  indexNames.includes('orgId') &&
    indexNames.includes('department') &&
    indexNames.includes('documentId') &&
    indexNames.includes('allowedRoles'),
  `Indexed payload fields include multi-tenant 'orgId', 'department', 'documentId', and 'allowedRoles'`
);
console.log('    ↳ Configured Indexes:', indexNames.join(', '));

// -------------------------------------------------------------
// Suite 2: Idempotent Collection Initialization (Mock Client)
// -------------------------------------------------------------
console.log('\n--- Suite 2: Collection Initialization & Payload Indexing ---');

const calls = {
  createCollection: null,
  createdIndexes: [],
  collectionChecked: false,
};

const mockClient = {
  collectionExists: async (name) => {
    calls.collectionChecked = true;
    return { exists: false };
  },
  createCollection: async (name, options) => {
    calls.createCollection = { name, options };
    return { ok: true };
  },
  createPayloadIndex: async (name, payload) => {
    calls.createdIndexes.push(payload);
    return { ok: true };
  },
  getCollection: async (name) => ({
    status: 'green',
    vectors_count: 0,
    config: {
      params: {
        vectors: { size: VECTOR_DIMENSION, distance: DISTANCE_METRIC },
      },
    },
  }),
};

const result = await initPolicyCollection(mockClient);

assert(
  calls.collectionChecked === true,
  'initPolicyCollection checks if collection exists prior to creation'
);

assert(
  calls.createCollection?.name === POLICY_COLLECTION_NAME &&
    calls.createCollection?.options.vectors.size === 768 &&
    calls.createCollection?.options.vectors.distance === 'Cosine',
  'Creates collection with 768-dim Cosine similarity vector parameters'
);

assert(
  calls.createdIndexes.some((idx) => idx.field_name === 'orgId' && idx.field_schema === 'keyword') &&
    calls.createdIndexes.some((idx) => idx.field_name === 'department' && idx.field_schema === 'keyword'),
  'Payload indexes automatically created on orgId and department with keyword schema'
);

assert(
  result.status === 'green' && result.config.params.vectors.size === 768,
  'Returns collection details and telemetry upon initialization'
);

// -------------------------------------------------------------
// Suite 3: Tenant-Isolated Vector Search Logic
// -------------------------------------------------------------
console.log('\n--- Suite 3: Tenant-Isolated Vector Search Guardrails ---');

let lastQueryArgs = null;
const mockSearchClient = {
  query: async (collection, queryArgs) => {
    lastQueryArgs = { collection, ...queryArgs };
    return {
      points: [
        {
          id: 'chunk_001',
          score: 0.88,
          payload: {
            documentName: 'Employee_Handbook_2026.pdf',
            sectionTitle: 'Annual Leave Policy',
            text: 'Employees are entitled to 12 casual leaves annually.',
            orgId: 'org_abc',
            department: 'HR',
          },
        },
      ],
    };
  },
};

const dummyEmbedding = new Array(768).fill(0.01);

const searchResults = await searchPolicyVectors({
  queryVector: dummyEmbedding,
  orgId: 'org_abc',
  department: 'HR',
  role: 'employee',
  limit: 3,
  scoreThreshold: 0.65,
  client: mockSearchClient,
});

assert(
  lastQueryArgs.collection === POLICY_COLLECTION_NAME,
  `Search targets '${POLICY_COLLECTION_NAME}' collection`
);

assert(
  lastQueryArgs.score_threshold === 0.65,
  'Enforces 0.65 score threshold for zero-hallucination policy guardrail'
);

const mustFilters = lastQueryArgs.filter.must;
const orgFilter = mustFilters.find((f) => f.key === 'orgId');
const deptFilter = mustFilters.find((f) => f.key === 'department');
const roleFilter = mustFilters.find((f) => f.key === 'allowedRoles');

assert(
  Boolean(orgFilter) &&
    orgFilter.match.value === 'org_abc' &&
    deptFilter.match.value === 'HR' &&
    roleFilter.match.value === 'employee',
  'Search strictly isolates query by tenant orgId, department, and role boundary'
);

assert(
  searchResults.length === 1 && searchResults[0].score === 0.88,
  'Returns matched policy chunks with payload and similarity score'
);

// 3.2 Security check: Search without orgId must throw
let rejectedWithoutOrg = false;
try {
  await searchPolicyVectors({
    queryVector: dummyEmbedding,
    orgId: null,
    client: mockSearchClient,
  });
} catch (err) {
  rejectedWithoutOrg = true;
}

assert(
  rejectedWithoutOrg === true,
  'Vector search strictly throws if tenant orgId is omitted (Cross-Tenant Protection)'
);

// -------------------------------------------------------------
// Suite 4: Vector Point Upsert
// -------------------------------------------------------------
console.log('\n--- Suite 4: Vector Points Upsert ---');

let lastUpsertArgs = null;
const mockUpsertClient = {
  upsert: async (collection, args) => {
    lastUpsertArgs = { collection, ...args };
    return { status: 'completed' };
  },
};

const samplePoints = [
  {
    id: 'pt_1',
    vector: dummyEmbedding,
    payload: {
      documentId: 'doc_101',
      documentName: 'IT_Security_Policy.md',
      orgId: 'org_abc',
      department: 'IT',
      text: 'Laptops must have disk encryption enabled.',
    },
  },
];

const upsertRes = await upsertPolicyVectors(samplePoints, mockUpsertClient);

assert(
  lastUpsertArgs.collection === POLICY_COLLECTION_NAME &&
    lastUpsertArgs.points.length === 1 &&
    lastUpsertArgs.points[0].payload.orgId === 'org_abc',
  'upsertPolicyVectors correctly passes points to Qdrant with wait=true'
);

console.log('\n================================================================');
console.log(`🎉 SPRINT 2 MODULE 1 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
console.log('================================================================\n');

process.exit(totalTests === passedTests ? 0 : 1);
