/**
 * Citation Formatter Service
 * Standardizes evidence chunks into traceable in-text citations and
 * structured payloads for the Frontend Sliding Drawer.
 */

/**
 * Generate a clean, standardized citation label: [DocName § SectionTitle]
 *
 * @param {Object} chunk
 * @param {string} chunk.documentName
 * @param {string} [chunk.sectionTitle]
 * @returns {string} Standardized citation label
 */
export function formatCitationLabel(chunk) {
  const docName = (chunk.documentName || 'Corporate Policy')
    .replace(/\.[^/.]+$/, '') // Strip extension for clean display
    .replace(/_/g, ' '); // Replace underscores with spaces

  const section = chunk.sectionTitle && chunk.sectionTitle !== 'General'
    ? ` § ${chunk.sectionTitle}`
    : '';

  return `[${docName}${section}]`;
}

/**
 * Build rich, structured citation payloads from retrieved chunks
 * for the Frontend 3-Panel Context Drawer.
 *
 * @param {Array<Object>} chunks Retrieved policy chunks from retrieval.service
 * @returns {Array<Object>} Formatted citation payload list
 */
export function buildCitationPayload(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }

  return chunks.map((chunk, index) => {
    const citationIndex = index + 1;
    const docName = chunk.documentName || 'Policy Document';
    const sectionTitle = chunk.sectionTitle || 'General Policy';
    const score = typeof chunk.score === 'number' ? chunk.score : 0;
    const confidencePercent = Math.round(score * 100);

    return {
      citationId: `cite_${chunk.chunkId || citationIndex}`,
      index: citationIndex,
      badge: `[${citationIndex}]`,
      label: formatCitationLabel(chunk),
      documentId: chunk.documentId || `doc_${citationIndex}`,
      documentName: docName,
      sectionTitle,
      confidenceScore: Math.round(score * 1000) / 1000,
      confidencePercent,
      department: chunk.department || 'General',
      excerpt: chunk.text ? chunk.text.trim() : '',
      allowedRoles: chunk.allowedRoles || ['employee'],
      orgId: chunk.orgId,
    };
  });
}

/**
 * Extract which citations were actually referenced in the AI response text
 * e.g., if response text cites "[1]" or "[Leave Policy § Casual Leave]"
 *
 * @param {string} text AI generated response text
 * @param {Array<Object>} allCitations Full citation payload list
 * @returns {{ referencedCitations: Array<Object>, unusedCitations: Array<Object>, hasValidCitations: boolean }}
 */
export function extractReferencedCitations(text, allCitations) {
  if (!text || typeof text !== 'string' || !Array.isArray(allCitations)) {
    return {
      referencedCitations: [],
      unusedCitations: allCitations || [],
      hasValidCitations: false,
    };
  }

  const referenced = [];
  const unused = [];

  for (const citation of allCitations) {
    // Check for numerical badge [1], [2] or full label [Doc § Section]
    const badgeRegex = new RegExp(`\\[${citation.index}\\]`, 'g');
    const labelSubstr = citation.label ? text.includes(citation.label) : false;

    if (badgeRegex.test(text) || labelSubstr) {
      referenced.push(citation);
    } else {
      unused.push(citation);
    }
  }

  return {
    referencedCitations: referenced,
    unusedCitations: unused,
    hasValidCitations: referenced.length > 0,
  };
}

/**
 * Extract a focused snippet around the most relevant match terms
 *
 * @param {string} text Full chunk text
 * @param {string} [query] User search query
 * @param {number} [maxLength=200] Snippet character length
 * @returns {string} Focused excerpt
 */
export function extractHighlightSnippet(text, query = '', maxLength = 200) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= maxLength) return text.trim();

  // If query terms provided, center snippet around first matching keyword
  if (query && typeof query === 'string') {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    const lowerText = text.toLowerCase();
    for (const term of terms) {
      const idx = lowerText.indexOf(term);
      if (idx !== -1) {
        const start = Math.max(0, idx - Math.floor(maxLength / 3));
        const end = Math.min(text.length, start + maxLength);
        const prefix = start > 0 ? '...' : '';
        const suffix = end < text.length ? '...' : '';
        return `${prefix}${text.substring(start, end).trim()}${suffix}`;
      }
    }
  }

  // Default: first maxLength chars
  return `${text.substring(0, maxLength).trim()}...`;
}

/**
 * Package AI answer with verified citations for SSE streaming or REST response
 *
 * @param {Object} params
 * @param {string} params.answerText AI text response
 * @param {Array<Object>} params.chunks Raw or normalized policy chunks
 * @param {string} [params.query] Original user query
 * @returns {Object} Standardized RAG response envelope
 */
export function packageResponseWithCitations({ answerText, chunks = [], query = '' }) {
  const citations = buildCitationPayload(chunks);
  const { referencedCitations, hasValidCitations } = extractReferencedCitations(
    answerText,
    citations
  );

  return {
    answer: answerText,
    isGrounded: citations.length > 0,
    hasCitations: hasValidCitations,
    citationsCount: citations.length,
    referencedCount: referencedCitations.length,
    // Provide full citation drawer payload
    citations,
    // Filtered list of citations actually referenced in the answer
    activeCitations: hasValidCitations ? referencedCitations : citations,
  };
}
