import {
  formatCitationLabel,
  buildCitationPayload,
  extractReferencedCitations,
  extractHighlightSnippet,
  packageResponseWithCitations,
} from '../src/services/rag/citation.service.js';

console.log('================================================================');
console.log('📚 OMNIDESK AI — SPRINT 2 MODULE 4: CITATION FORMATTER VERIFICATION');
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
// TEST SUITE 1: Standardized Citation Label Formatting
// =============================================================
console.log('--- Suite 1: Standardized Citation Label Formatting ---');

const sampleChunk1 = {
  documentName: 'Employee_Handbook_2026.pdf',
  sectionTitle: 'Annual Leave Entitlements',
  score: 0.892,
  text: 'All full-time employees receive 12 casual leaves per calendar year.',
  department: 'HR',
  orgId: 'org_abc',
};

const label1 = formatCitationLabel(sampleChunk1);
assert(
  label1 === '[Employee Handbook 2026 § Annual Leave Entitlements]',
  `Formats citation label as '[DocName § SectionTitle]' (Got: ${label1})`
);

const sampleChunkGeneric = {
  documentName: 'General_Rules.md',
  sectionTitle: 'General',
};
const labelGeneric = formatCitationLabel(sampleChunkGeneric);
assert(
  labelGeneric === '[General Rules]',
  `Omits redundant '§ General' section heading (Got: ${labelGeneric})`
);

// =============================================================
// TEST SUITE 2: Rich Citation Payload for Frontend Drawer
// =============================================================
console.log('\n--- Suite 2: Rich Citation Drawer Payload Generation ---');

const sampleChunks = [
  sampleChunk1,
  {
    chunkId: 'chunk_202',
    documentName: 'IT_Hardware_Policy.pdf',
    sectionTitle: 'Workstation Refresh Cycle',
    score: 0.745,
    text: 'Engineering workstations (MacBook Pro) are refreshed every 36 months of active service.',
    department: 'IT',
    orgId: 'org_abc',
  },
];

const payloads = buildCitationPayload(sampleChunks);

assert(
  payloads.length === 2,
  'Generates citation payload for all retrieved evidence chunks'
);

const firstPayload = payloads[0];
assert(
  firstPayload.badge === '[1]' &&
    firstPayload.confidencePercent === 89 &&
    firstPayload.confidenceScore === 0.892 &&
    firstPayload.department === 'HR' &&
    firstPayload.excerpt.includes('12 casual leaves'),
  'First citation incorporates numeric badge [1], confidence % (89%), department, and excerpt'
);

const secondPayload = payloads[1];
assert(
  secondPayload.badge === '[2]' &&
    secondPayload.confidencePercent === 75 &&
    secondPayload.documentName === 'IT_Hardware_Policy.pdf',
  'Second citation incorporates numeric badge [2] with 75% confidence score'
);
console.log('    ↳ Generated Badges:', payloads.map((p) => `${p.badge} ${p.label} (${p.confidencePercent}%)`).join(' | '));

// =============================================================
// TEST SUITE 3: In-Text Citation Extraction & Linking
// =============================================================
console.log('\n--- Suite 3: In-Text Citation Extraction & Linking ---');

const sampleAiResponse =
  'Under company policy [1], you are entitled to 12 casual leaves annually. Workstations are eligible for refresh every 36 months [2].';

const { referencedCitations, unusedCitations, hasValidCitations } =
  extractReferencedCitations(sampleAiResponse, payloads);

assert(
  hasValidCitations === true && referencedCitations.length === 2,
  'Detects and links in-text numerical citation badges [1] and [2] in LLM response'
);

assert(
  unusedCitations.length === 0,
  'Correctly identifies 0 unused citations when all citations were referenced'
);

// Test partial reference
const partialResponse = 'You receive 12 casual leaves [1].';
const partialCheck = extractReferencedCitations(partialResponse, payloads);
assert(
  partialCheck.referencedCitations.length === 1 &&
    partialCheck.referencedCitations[0].index === 1 &&
    partialCheck.unusedCitations.length === 1 &&
    partialCheck.unusedCitations[0].index === 2,
  'Identifies active vs unused citations when only a subset was cited'
);

// =============================================================
// TEST SUITE 4: Focused Excerpt Snippet Extraction
// =============================================================
console.log('\n--- Suite 4: Highlight Excerpt Snippet Extraction ---');

const longPolicyText =
  'Company benefits overview. ABC Technologies provides comprehensive medical coverage. In addition, maternity leave is provided for 90 consecutive calendar days for eligible female employees with full pay. Paternity leave is 10 days.';

const snippet = extractHighlightSnippet(longPolicyText, 'maternity leave', 120);
assert(
  snippet.includes('maternity leave') && snippet.length <= 130,
  'Extracts focused excerpt centered around query search keywords'
);
console.log('    ↳ Focused Snippet:', snippet);

// =============================================================
// TEST SUITE 5: Full Response Packaging for API & SSE
// =============================================================
console.log('\n--- Suite 5: Full Response Envelope Packaging ---');

const packaged = packageResponseWithCitations({
  answerText: sampleAiResponse,
  chunks: sampleChunks,
  query: 'How many leaves do I get?',
});

assert(
  packaged.isGrounded === true &&
    packaged.hasCitations === true &&
    packaged.citationsCount === 2 &&
    packaged.referencedCount === 2 &&
    packaged.activeCitations.length === 2,
  'Packages grounded RAG response envelope with complete citation drawer metadata'
);

// Out-of-scope response packaging
const ungroundedPackaged = packageResponseWithCitations({
  answerText: 'No company policy covers this topic.',
  chunks: [],
});

assert(
  ungroundedPackaged.isGrounded === false &&
    ungroundedPackaged.hasCitations === false &&
    ungroundedPackaged.citationsCount === 0,
  'Handles ungrounded fallback responses with clean empty citation lists'
);

console.log('\n================================================================');
console.log(`🎉 SPRINT 2 MODULE 4 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
console.log('================================================================\n');

process.exit(totalTests === passedTests ? 0 : 1);
