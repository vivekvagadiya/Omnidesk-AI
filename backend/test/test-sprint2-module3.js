import {
  retrievePolicyContext,
  formatContextBlock,
  SIMILARITY_THRESHOLD,
  RetrievalError,
  ZERO_HALLUCINATION_FALLBACK,
} from '../src/services/rag/retrieval.service.js';
import { generateTestEmbedding } from '../src/services/rag/ingestion.service.js';

console.log('================================================================');
console.log('🎯 OMNIDESK AI — SPRINT 2 MODULE 3: RETRIEVAL & ZERO-HALLUCINATION GUARDRAIL');
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

// =============================================================
// TEST SUITE 1: Multi-Tenant Isolation Guardrail
// =============================================================
console.log('--- Suite 1: Tenant-Isolated Policy Search ---');

let capturedSearchArgs = null;
const mockQdrantClient = {
  query: async (collection, args) => {
    capturedSearchArgs = args;
    return {
      points: [
        {
          id: 'chunk_101',
          score: 0.89,
          payload: {
            documentId: 'doc_hr_01',
            documentName: 'ABC_Tech_Leave_Policy.pdf',
            sectionTitle: 'Casual Leave Entitlements',
            text: 'Employees are credited with 12 casual leaves and 7 sick leaves annually.',
            orgId: 'org_abc',
            department: 'HR',
            allowedRoles: ['employee', 'manager'],
          },
        },
      ],
    };
  },
};

// 1.1: Multi-tenant query execution
const userSarah = { userId: 'emp_101', orgId: 'org_abc', role: 'employee' };
const resSarah = await retrievePolicyContext({
  query: 'How many casual leaves do I receive?',
  user: userSarah,
  department: 'HR',
  embeddingProvider: generateTestEmbedding,
  qdrantClient: mockQdrantClient,
});

assert(
  resSarah.isGrounded === true && resSarah.orgId === 'org_abc',
  'retrievePolicyContext resolves tenant context from authenticated user'
);

const mustFilters = capturedSearchArgs.filter.must;
const orgFilter = mustFilters.find((f) => f.key === 'orgId');
const deptFilter = mustFilters.find((f) => f.key === 'department');
const roleFilter = mustFilters.find((f) => f.key === 'allowedRoles');

assert(
  orgFilter?.match?.value === 'org_abc' &&
    deptFilter?.match?.value === 'HR' &&
    roleFilter?.match?.value === 'employee',
  'Passes tenant orgId, department, and role constraints to Qdrant filter'
);

// 1.2: Cross-tenant isolation breach prevention (missing orgId must throw)
let tenantBreachThrown = false;
try {
  await retrievePolicyContext({
    query: 'Show me admin policies',
    orgId: null,
    user: null,
    embeddingProvider: generateTestEmbedding,
    qdrantClient: mockQdrantClient,
  });
} catch (err) {
  if (err instanceof RetrievalError && err.message.includes('Tenant isolation breach')) {
    tenantBreachThrown = true;
  }
}
assert(
  tenantBreachThrown === true,
  'Search strictly blocks cross-tenant execution if orgId is omitted (400 RetrievalError)'
);

// =============================================================
// TEST SUITE 2: Similarity Threshold Filtering (score >= 0.65)
// =============================================================
console.log('\n--- Suite 2: Similarity Threshold Filtering (Cutoff >= 0.65) ---');

assert(
  SIMILARITY_THRESHOLD === 0.65,
  'Zero-hallucination similarity threshold configured as 0.65'
);

const mockThresholdClient = {
  query: async () => ({
    points: [
      {
        id: 'chunk_high',
        score: 0.88,
        payload: {
          documentName: 'Policy_High.pdf',
          sectionTitle: 'High Relevance',
          text: 'Exact policy match with high confidence.',
          orgId: 'org_abc',
        },
      },
      {
        id: 'chunk_mid',
        score: 0.67,
        payload: {
          documentName: 'Policy_Mid.pdf',
          sectionTitle: 'Acceptable Relevance',
          text: 'Acceptable policy match above 0.65.',
          orgId: 'org_abc',
        },
      },
      {
        id: 'chunk_low',
        score: 0.54, // Below 0.65
        payload: {
          documentName: 'Policy_Low.pdf',
          sectionTitle: 'Irrelevant',
          text: 'Irrelevant text below threshold.',
          orgId: 'org_abc',
        },
      },
    ],
  }),
};

const thresholdResult = await retrievePolicyContext({
  query: 'Policy inquiry',
  orgId: 'org_abc',
  embeddingProvider: generateTestEmbedding,
  qdrantClient: mockThresholdClient,
});

assert(
  thresholdResult.chunks.length === 2 &&
    thresholdResult.chunks.every((c) => c.score >= 0.65),
  'Filters out chunks with similarity score below 0.65 (retaining 0.88 and 0.67)'
);

assert(
  thresholdResult.highestScore === 0.88,
  'Identifies highest relevance score among accepted chunks'
);

// =============================================================
// TEST SUITE 3: Zero-Hallucination Fallback Trigger
// =============================================================
console.log('\n--- Suite 3: Zero-Hallucination Fallback Trigger ---');

// Mock empty results (out-of-scope query, e.g. "Can I bring my pet tiger to office?")
const mockEmptyClient = {
  query: async () => ({ points: [] }),
};

const fallbackResult = await retrievePolicyContext({
  query: 'Can I bring my pet tiger to work on Fridays?',
  orgId: 'org_abc',
  embeddingProvider: generateTestEmbedding,
  qdrantClient: mockEmptyClient,
});

assert(
  fallbackResult.isGrounded === false &&
    fallbackResult.hasResults === false &&
    fallbackResult.chunks.length === 0,
  'Out-of-scope query returns isGrounded=false and zero chunks'
);

assert(
  fallbackResult.fallbackMessage.includes('No company policy covers this topic') &&
    fallbackResult.suggestedAction?.type === 'createTicket',
  'Triggers structured fallback message suggesting HR/IT ticket creation'
);
console.log('    ↳ Fallback Message:', fallbackResult.fallbackMessage);

// =============================================================
// TEST SUITE 4: LLM Context Block Formatting
// =============================================================
console.log('\n--- Suite 4: Evidence Context Block Formatting ---');

const sampleEvidenceChunks = [
  {
    documentName: 'Leave_Handbook_2026.pdf',
    sectionTitle: 'Annual Leave',
    score: 0.91,
    text: 'Full-time employees receive 12 casual leaves annually.',
  },
  {
    documentName: 'Leave_Handbook_2026.pdf',
    sectionTitle: 'Sick Leave',
    score: 0.78,
    text: 'Sick leaves are provided up to 7 days per year.',
  },
];

const contextBlock = formatContextBlock(sampleEvidenceChunks);

assert(
  contextBlock.includes('[1] Source: Leave_Handbook_2026.pdf § Annual Leave (Relevance: 91%)') &&
    contextBlock.includes('[2] Source: Leave_Handbook_2026.pdf § Sick Leave (Relevance: 78%)'),
  'Formats numbered evidence citations with document name, section title, and relevance percentage'
);

assert(
  contextBlock.includes('VERIFIED ORGANIZATION POLICY EVIDENCE'),
  'Wraps context in clear system prompt guardrail boundaries'
);

// =============================================================
// TEST SUITE 5: End-to-End Grounded Retrieval Response
// =============================================================
console.log('\n--- Suite 5: End-to-End Grounded Retrieval ---');

const groundedQuery = 'How many sick days am I allowed?';
const groundedResult = await retrievePolicyContext({
  query: groundedQuery,
  user: userSarah,
  department: 'HR',
  embeddingProvider: generateTestEmbedding,
  qdrantClient: mockQdrantClient,
});

assert(
  groundedResult.isGrounded === true &&
    groundedResult.totalChunksFound === 1 &&
    groundedResult.chunks[0].confidencePercent === 89 &&
    Boolean(groundedResult.contextBlock),
  'Returns fully grounded retrieval payload with evidence context block'
);

console.log('\n================================================================');
console.log(`🎉 SPRINT 2 MODULE 3 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
console.log('================================================================\n');

process.exit(totalTests === passedTests ? 0 : 1);
