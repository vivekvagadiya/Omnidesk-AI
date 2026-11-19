/**
 * PII Masking & Surrogate Tokenization Service
 * Week 9 Security Guardrail: Protects employee privacy by sanitizing
 * sensitive entities (Salaries, Credit Cards, Phones, SSNs, Personal Emails)
 * before passing prompts to external LLMs, and de-tokenizes before returning to user.
 */

// Corporate domain to preserve (corporate identities are allowed)
export const PRESERVED_DOMAIN = 'abctech.com';

/**
 * Standard PII Detection Patterns
 */
export const PII_PATTERNS = [
  // 1. Social Security Numbers (SSN): 123-45-6789
  {
    type: 'SSN',
    prefix: 'SSN',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },

  // 2. Credit Card Numbers: 15-16 digits with dashes, spaces, or raw digits
  {
    type: 'CREDIT_CARD',
    prefix: 'CREDIT_CARD',
    regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11}|(?:\d{4}[-\s]){3}\d{4}|\b\d{16}\b)\b/g,
  },

  // 3. Salaries & Monetary Figures: $145,000, €90,000, 120k USD, $120k, $75,500.00
  {
    type: 'SALARY',
    prefix: 'SALARY',
    regex: /(?:(?:\$|€|£|CAD|USD|EUR|GBP)\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?:\s?(?:k|K|thousand|million|annually|per year|base|bonus))?|\b\d{2,3}(?:,\d{3})+\s?(?:USD|EUR|dollars|euros|per annum)\b)/gi,
  },

  // 4. Phone Numbers: US and International formats
  {
    type: 'PHONE',
    prefix: 'PHONE',
    regex: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  },

  // 5. Personal Emails: Non-corporate email addresses (excludes @abctech.com)
  {
    type: 'EMAIL',
    prefix: 'EMAIL',
    regex: new RegExp(
      `\\b[A-Za-z0-9._%+-]+@(?!${PRESERVED_DOMAIN.replace('.', '\\.')})[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b`,
      'gi'
    ),
  },
];

/**
 * Detect all PII entities in a text string without modifying it
 *
 * @param {string} text
 * @returns {Array<{ type: string, value: string, index: number }>}
 */
export function detectPII(text) {
  if (!text || typeof text !== 'string') return [];

  const detections = [];

  for (const { type, regex } of PII_PATTERNS) {
    // Clone regex with sticky/global index reset
    const matcher = new RegExp(regex.source, regex.flags);
    let match;
    while ((match = matcher.exec(text)) !== null) {
      detections.push({
        type,
        value: match[0],
        index: match.index,
      });
    }
  }

  // Sort by index ascending
  return detections.sort((a, b) => a.index - b.index);
}

/**
 * Mask sensitive PII entities with reversible surrogate tokens
 * (e.g. $145,000 -> [SALARY_1], 4532-1234-5678-9012 -> [CREDIT_CARD_1])
 *
 * @param {string} text Input text containing potential PII
 * @returns {{ maskedText: string, tokenMap: Record<string, string>, hasPII: boolean, detectedCounts: Record<string, number>, totalCount: number }}
 */
export function maskPII(text) {
  if (!text || typeof text !== 'string') {
    return {
      maskedText: text || '',
      tokenMap: {},
      hasPII: false,
      detectedCounts: {},
      totalCount: 0,
    };
  }

  let maskedText = text;
  const tokenMap = {};
  const detectedCounts = {};
  const typeCounters = {};

  for (const { type, prefix, regex } of PII_PATTERNS) {
    const matcher = new RegExp(regex.source, regex.flags);
    const matches = maskedText.match(matcher);

    if (matches && matches.length > 0) {
      detectedCounts[type] = matches.length;

      // Deduplicate matches to assign consistent tokens
      const uniqueMatches = Array.from(new Set(matches));

      for (const val of uniqueMatches) {
        typeCounters[prefix] = (typeCounters[prefix] || 0) + 1;
        const surrogateToken = `[${prefix}_${typeCounters[prefix]}]`;

        // Store mapping for reverse de-tokenization
        tokenMap[surrogateToken] = val;

        // Replace all occurrences of this exact PII string with surrogate token
        maskedText = maskedText.replaceAll(val, surrogateToken);
      }
    }
  }

  const totalCount = Object.values(detectedCounts).reduce((sum, n) => sum + n, 0);

  return {
    maskedText,
    tokenMap,
    hasPII: totalCount > 0,
    detectedCounts,
    totalCount,
  };
}

/**
 * De-tokenize: Restore original values from surrogate tokens in LLM responses
 *
 * @param {string} text Text containing surrogate tokens (e.g. from LLM answer)
 * @param {Record<string, string>} tokenMap Token-to-value mapping dictionary
 * @returns {string} De-tokenized original text
 */
export function unmaskPII(text, tokenMap = {}) {
  if (!text || typeof text !== 'string' || !tokenMap || Object.keys(tokenMap).length === 0) {
    return text || '';
  }

  let restoredText = text;

  // Replace each surrogate token with its original raw value
  for (const [token, originalValue] of Object.entries(tokenMap)) {
    restoredText = restoredText.replaceAll(token, originalValue);
  }

  return restoredText;
}
