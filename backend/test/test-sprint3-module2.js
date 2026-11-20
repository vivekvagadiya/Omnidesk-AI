import {
  detectPII,
  maskPII,
  unmaskPII,
  PRESERVED_DOMAIN,
} from '../src/services/ai/piiMasker.service.js';
import { runCopilotTurn } from '../src/services/ai/orchestrator.service.js';
import { generateTestEmbedding } from '../src/services/rag/ingestion.service.js';
import { connectRedis, disconnectRedis } from '../src/config/redis.js';

console.log('================================================================');
console.log('🛡️  OMNIDESK AI — SPRINT 3 MODULE 2: PII MASKING & SURROGATE TOKENIZATION');
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
// TEST SUITE 1: PII Entity Detection
// =============================================================
console.log('--- Suite 1: PII Entity Detection ---');

const samplePiiText =
  'Employee SSN is 123-45-6789. Base salary is $145,000 per year. Corporate card 4532-1234-5678-9012. Direct phone +1-555-019-2834. Personal email alex@gmail.com and corporate email alex@abctech.com.';

const detections = detectPII(samplePiiText);
const detectedTypes = detections.map((d) => d.type);

assert(
  detectedTypes.includes('SSN') &&
    detections.find((d) => d.type === 'SSN').value === '123-45-6789',
  'Detects Social Security Number (123-45-6789)'
);

assert(
  detectedTypes.includes('SALARY') &&
    detections.find((d) => d.type === 'SALARY').value.includes('145,000'),
  'Detects monetary salary figure ($145,000)'
);

assert(
  detectedTypes.includes('CREDIT_CARD') &&
    detections.find((d) => d.type === 'CREDIT_CARD').value === '4532-1234-5678-9012',
  'Detects credit card number (4532-1234-5678-9012)'
);

assert(
  detectedTypes.includes('PHONE') &&
    detections.find((d) => d.type === 'PHONE').value.includes('555-019-2834'),
  'Detects phone number (+1-555-019-2834)'
);

assert(
  detectedTypes.includes('EMAIL') &&
    detections.find((d) => d.type === 'EMAIL').value === 'alex@gmail.com',
  'Detects personal email (alex@gmail.com)'
);

const corporateEmailDetected = detections.some((d) => d.value === 'alex@abctech.com');
assert(
  corporateEmailDetected === false,
  `Preserves corporate domain identities (@${PRESERVED_DOMAIN}) without false-positive masking`
);

// =============================================================
// TEST SUITE 2: Pre-LLM Surrogate Tokenization (maskPII)
// =============================================================
console.log('\n--- Suite 2: Pre-LLM Surrogate Tokenization ---');

const { maskedText, tokenMap, hasPII, totalCount } = maskPII(samplePiiText);

assert(
  hasPII === true && totalCount >= 5,
  'maskPII flags presence of sensitive PII (hasPII = true)'
);

assert(
  maskedText.includes('[SSN_1]') &&
    !maskedText.includes('123-45-6789'),
  'Replaces raw SSN with surrogate token [SSN_1]'
);

assert(
  maskedText.includes('[SALARY_1]') &&
    !maskedText.includes('$145,000'),
  'Replaces raw salary with surrogate token [SALARY_1]'
);

assert(
  maskedText.includes('[CREDIT_CARD_1]') &&
    !maskedText.includes('4532-1234-5678-9012'),
  'Replaces raw credit card with surrogate token [CREDIT_CARD_1]'
);

assert(
  maskedText.includes('[PHONE_1]') &&
    !maskedText.includes('+1-555-019-2834'),
  'Replaces raw phone number with surrogate token [PHONE_1]'
);

assert(
  tokenMap['[CREDIT_CARD_1]'] === '4532-1234-5678-9012' &&
    tokenMap['[SSN_1]'] === '123-45-6789',
  'Constructs reversible tokenMap for post-LLM de-tokenization'
);

console.log('    ↳ Masked Text Excerpt:', maskedText.substring(0, 140) + '...');

// Clean text without PII
const cleanText = 'What are the office hours for ABC Technologies?';
const cleanMask = maskPII(cleanText);
assert(
  cleanMask.hasPII === false && cleanMask.maskedText === cleanText,
  'Passes clean text without PII unmodified (zero overhead)'
);

// =============================================================
// TEST SUITE 3: Post-LLM De-Tokenization (unmaskPII)
// =============================================================
console.log('\n--- Suite 3: Post-LLM De-Tokenization ---');

const mockLlmAnswer =
  'Under our travel reimbursement policy [1], your expense of [SALARY_1] on card [CREDIT_CARD_1] will be reimbursed to [PHONE_1].';

const unmaskedAnswer = unmaskPII(mockLlmAnswer, tokenMap);

assert(
  unmaskedAnswer.includes('$145,000') &&
    unmaskedAnswer.includes('4532-1234-5678-9012') &&
    unmaskedAnswer.includes('+1-555-019-2834'),
  'Restores all original raw values from surrogate tokens in the LLM response'
);

assert(
  !unmaskedAnswer.includes('[SALARY_1]') &&
    !unmaskedAnswer.includes('[CREDIT_CARD_1]') &&
    !unmaskedAnswer.includes('[PHONE_1]'),
  'Completely removes all surrogate tokens from final user-facing response'
);
console.log('    ↳ De-tokenized Response:', unmaskedAnswer);

// =============================================================
// TEST SUITE 4: End-to-End Orchestrator Turn with PII Protection
// =============================================================
console.log('\n--- Suite 4: End-to-End Orchestrator Turn with PII Protection ---');

await connectRedis();

const piiSessionId = `pii_sess_${Date.now()}`;
const employeeSarah = {
  name: 'Sarah Jenkins',
  userId: 'emp_101',
  role: 'employee',
  orgId: 'org_abc',
  department: 'Engineering',
};

// Mock Qdrant client
const mockQdrantClient = {
  query: async () => ({
    points: [
      {
        id: 'chunk_reimburse_01',
        score: 0.88,
        payload: {
          documentId: 'doc_travel',
          documentName: 'Travel_Expense_Policy.pdf',
          sectionTitle: 'Expense Reimbursements',
          text: 'Corporate expenses must be submitted within 30 days of purchase.',
          department: 'FINANCE',
          orgId: 'org_abc',
        },
      },
    ],
  }),
};

let capturedLlmPrompt = '';
const mockLlmWithPiiAudit = async ({ message, tokenMap }) => {
  capturedLlmPrompt = message;
  // Verify LLM ONLY receives surrogate tokens, NEVER raw PII
  assert(
    !message.includes('4532-1234-5678-9012') && message.includes('[CREDIT_CARD_1]'),
    'Enterprise Guardrail Verified: LLM never receives raw credit card number (sees [CREDIT_CARD_1])'
  );

  return 'I have recorded your expense on card [CREDIT_CARD_1] under company policy [1].';
};

const copilotTurnWithPii = await runCopilotTurn({
  sessionId: piiSessionId,
  message: 'Can I expense flight tickets booked on my card 4532-1234-5678-9012 for $850.00?',
  user: employeeSarah,
  customLlmProvider: mockLlmWithPiiAudit,
  customEmbeddingProvider: generateTestEmbedding,
  qdrantClient: mockQdrantClient,
});

assert(
  copilotTurnWithPii.hasPII === true && copilotTurnWithPii.piiMasked === true,
  'Copilot turn metadata indicates PII was detected and masked'
);

assert(
  copilotTurnWithPii.answer.includes('4532-1234-5678-9012') &&
    !copilotTurnWithPii.answer.includes('[CREDIT_CARD_1]'),
  'End user seamlessly receives response with original card number restored'
);

await disconnectRedis();

console.log('\n================================================================');
console.log(`🎉 SPRINT 3 MODULE 2 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
console.log('================================================================\n');

process.exit(totalTests === passedTests ? 0 : 1);
