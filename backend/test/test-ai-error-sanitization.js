import assert from 'node:assert';
import {
  sanitizeAiErrorMessage,
  isTransientOrRateLimitError,
  AiProviderError,
} from '../src/services/ai/orchestrator.service.js';

console.log('================================================================');
console.log('🛡️  OMNIDESK AI — AI ERROR SANITIZATION UNIT TESTS');
console.log('================================================================');

// Exact raw Google GenAI error string reported by the user
const rawQuotaErrorJson = JSON.stringify({
  error: {
    code: 429,
    message: "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://aistudio.google.com/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash, description: Generate content requests per day limit exceeded on Free Tier. See https://aistudio.google.com/docs/rate-limits.\nPlease retry in 3h52m31.179939565s.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.Help",
        links: [{ description: "Learn more about Gemini API quotas", url: "https://aistudio.google.com/docs/rate-limits" }]
      }
    ]
  }
});

// Exact raw 503 error string reported by the user
const raw503ErrorJson = JSON.stringify({
  error: {
    code: 503,
    message: "This model is currently experienncing high demand. Spikes in demand are usually temporary. Please try again later.",
    status: "UNAVAILABLE"
  }
});

// Test 1: Quota 429 Error Sanitization
const sanitizedQuota = sanitizeAiErrorMessage(new Error(rawQuotaErrorJson));
console.log('\n[Test 1] Sanitized Quota Error Message:');
console.log(`  -> "${sanitizedQuota}"`);
assert(
  !sanitizedQuota.includes('{') &&
  !sanitizedQuota.includes('http') &&
  !sanitizedQuota.includes('generativelanguage.googleapis.com') &&
  !sanitizedQuota.includes('RESOURCE_EXHAUSTED'),
  'Must not leak raw JSON, Google URLs, or internal quota details'
);
assert(
  sanitizedQuota.toLowerCase().includes('quota') || sanitizedQuota.toLowerCase().includes('demand'),
  'Must convey a user-friendly rate limit / quota message'
);
console.log('  ✅ [PASS] 429 Quota error sanitized cleanly');

// Test 2: 503 High Demand Error Sanitization
const sanitized503 = sanitizeAiErrorMessage(new Error(raw503ErrorJson));
console.log('\n[Test 2] Sanitized 503 Error Message:');
console.log(`  -> "${sanitized503}"`);
assert(
  !sanitized503.includes('{') && !sanitized503.includes('UNAVAILABLE'),
  'Must not leak raw JSON or enum status'
);
assert(
  sanitized503.toLowerCase().includes('busy') || sanitized503.toLowerCase().includes('demand'),
  'Must convey a friendly high demand message'
);
console.log('  ✅ [PASS] 503 Service Unavailable sanitized cleanly');

// Test 3: Timeout Error Sanitization
const sanitizedTimeout = sanitizeAiErrorMessage(new Error('Gemini request timed out after 25000ms'));
console.log('\n[Test 3] Sanitized Timeout Error Message:');
console.log(`  -> "${sanitizedTimeout}"`);
assert(sanitizedTimeout.toLowerCase().includes('too long'), 'Must convey timeout');
console.log('  ✅ [PASS] Timeout sanitized cleanly');

// Test 4: isTransientOrRateLimitError Detection
assert(
  isTransientOrRateLimitError(new Error(rawQuotaErrorJson)) === true,
  'isTransientOrRateLimitError must return true for JSON 429 quota error'
);
assert(
  isTransientOrRateLimitError(new Error(raw503ErrorJson)) === true,
  'isTransientOrRateLimitError must return true for JSON 503 error'
);
assert(
  isTransientOrRateLimitError({ status: 429 }) === true,
  'isTransientOrRateLimitError must return true for status 429'
);
console.log('\n[Test 4] Transient & rate limit error detection:');
console.log('  ✅ [PASS] Accurately detects 429 and 503 across raw JSON and status codes');

// Test 5: AiProviderError Class
const aiErr = new AiProviderError('Clean user message', {
  statusCode: 503,
  originalError: new Error(rawQuotaErrorJson),
});
assert(aiErr.message === 'Clean user message', 'AiProviderError sets clean user-facing message');
assert(aiErr.statusCode === 503, 'AiProviderError retains HTTP status code');
assert(aiErr.originalError !== null, 'AiProviderError retains original error for server diagnostics');
console.log('\n[Test 5] AiProviderError encapsulation:');
console.log('  ✅ [PASS] Encapsulates clean user message while retaining debug diagnostics');

console.log('\n================================================================');
console.log('🎉 ALL AI ERROR SANITIZATION TESTS PASSED SUCCESSFULLY!');
console.log('================================================================\n');
