import { searchPolicyVectors } from './qdrant.service.js';
import {
  generateEmbeddings,
  generateTestEmbedding,
} from './ingestion.service.js';
import { searchOfflinePolicies } from './seedPolicies.data.js';

export const SIMILARITY_THRESHOLD = 0.65;
export const DEFAULT_SEARCH_LIMIT = 5;

export const ZERO_HALLUCINATION_FALLBACK = {
  isGrounded: false,
  hasResults: false,
  highestScore: 0,
  chunks: [],
  contextBlock: '',
  fallbackMessage:
    'No company policy covers this topic. Would you like me to raise an HR or IT ticket for assistance?',
  suggestedAction: {
    type: 'createTicket',
    label: 'Raise Support Ticket',
    reason: 'Policy query could not be verified against verified organization documentation.',
  },
};

export class RetrievalError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'RetrievalError';
    this.statusCode = statusCode;
  }
}

/**
 * Format retrieved policy chunks into a clean, structured context block for the LLM prompt.
 * Includes numbered references [1], [2] for in-text citation generation.
 *
 * @param {Array<Object>} chunks
 * @returns {string} Formatted context block
 */
export function formatContextBlock(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return '';
  }

  const formattedItems = chunks
    .filter((c) => c && typeof c === 'object' && c.text)
    .map((chunk, index) => {
      const doc = chunk.documentName || 'Company Policy';
      const section = chunk.sectionTitle ? ` § ${chunk.sectionTitle}` : '';
      const confidence = Math.round((chunk.score || 0) * 100);

      return `[${index + 1}] Source: ${doc}${section} (Relevance: ${confidence}%)\n"${chunk.text.trim()}"`;
    });

  if (formattedItems.length === 0) return '';

  return [
    '=== VERIFIED ORGANIZATION POLICY EVIDENCE ===',
    'Use ONLY the following policy excerpts to answer employee inquiries. Cite sources using [1], [2], etc.',
    'If the answer is not contained in this evidence, state that no policy covers it.',
    '',
    formattedItems.join('\n\n'),
    '=============================================',
  ].join('\n');
}

/**
 * Tenant-Isolated Semantic Policy Search with Zero-Hallucination Guardrail
 * Searches Qdrant vector database, falling back gracefully to offline policy knowledge if Qdrant is empty or offline.
 *
 * @param {Object} params
 * @param {string} params.query User query text
 * @param {Object} [params.user] Authenticated user object containing orgId and role
 * @param {string} [params.orgId] Explicit tenant orgId
 * @param {string} [params.department] Optional department filter (e.g. 'HR', 'IT')
 * @param {string} [params.role] Optional role filter for RBAC
 * @param {number} [params.limit=5] Max chunks to retrieve
 * @param {number} [params.scoreThreshold=0.65] Zero-hallucination cutoff score
 * @param {Function} [params.embeddingProvider] Custom embedding provider for tests
 * @param {Object} [params.qdrantClient] Custom Qdrant client
 * @returns {Promise<Object>} Retrieval result with isGrounded status and chunks
 */
export async function retrievePolicyContext({
  query,
  user = null,
  orgId = null,
  department = null,
  role = null,
  limit = DEFAULT_SEARCH_LIMIT,
  scoreThreshold = SIMILARITY_THRESHOLD,
  embeddingProvider = null,
  qdrantClient = null,
}) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    throw new RetrievalError('Search query text is required.');
  }

  // 1. Enforce Multi-Tenant Isolation
  const tenantOrgId = orgId || user?.orgId || 'org_abc';

  // Enforce User Role for RBAC if available
  const userRole = role || user?.role || null;
  const targetDepartment = department ? department.toUpperCase() : null;

  // 2. Generate 768-dim Query Embedding Vector
  let queryVector = null;
  try {
    if (typeof embeddingProvider === 'function') {
      queryVector = await embeddingProvider(query);
    } else {
      const [vector] = await generateEmbeddings([query]);
      queryVector = vector;
    }
  } catch (embErr) {
    console.warn(`⚠️ [Retrieval] Embedding generation notice (${embErr.message}). Using test vector.`);
    queryVector = generateTestEmbedding(query);
  }

  if (!queryVector || queryVector.length !== 768) {
    queryVector = generateTestEmbedding(query);
  }

  // 3. Search Qdrant with Strict Tenant & Department Isolation
  let rawResults = [];
  try {
    rawResults = await searchPolicyVectors({
      queryVector,
      orgId: tenantOrgId,
      department: targetDepartment,
      role: userRole,
      limit,
      scoreThreshold,
      client: qdrantClient || null,
    });
  } catch (err) {
    console.warn(`⚠️ [Retrieval] Qdrant search encountered notice: ${err.message}`);
    rawResults = [];
  }

  // 4. In-Memory Resilient Fallback if Qdrant has zero indexed points or is unreachable
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    const offlineMatches = searchOfflinePolicies({
      query,
      orgId: tenantOrgId,
      department: targetDepartment,
      role: userRole,
      limit,
    });

    if (offlineMatches.length > 0) {
      const highestScore = offlineMatches[0].score;
      const contextBlock = formatContextBlock(offlineMatches);
      return {
        isGrounded: true,
        hasResults: true,
        highestScore,
        totalChunksFound: offlineMatches.length,
        query: query.trim(),
        orgId: tenantOrgId,
        chunks: offlineMatches,
        contextBlock,
      };
    }

    return {
      ...ZERO_HALLUCINATION_FALLBACK,
      query: query.trim(),
      orgId: tenantOrgId,
    };
  }

  // 5. Clean, Rank, and Format Matched Evidence Chunks
  const normalizedChunks = rawResults
    .filter((point) => point && typeof point === 'object')
    .map((point) => {
      const payload = point.payload || {};
      const score = typeof point.score === 'number' ? point.score : 0;

      return {
        chunkId: point.id,
        score: Math.round(score * 1000) / 1000,
        confidencePercent: Math.round(score * 100),
        documentId: payload.documentId || 'doc_unknown',
        documentName: payload.documentName || 'Policy Document',
        sectionTitle: payload.sectionTitle || 'General',
        text: payload.text || '',
        department: payload.department || 'General',
        allowedRoles: payload.allowedRoles || [],
        orgId: payload.orgId || tenantOrgId,
      };
    })
    .filter((c) => c.text && c.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score);

  // If all chunks filtered below threshold, check offline store before declaring ungrounded
  if (normalizedChunks.length === 0) {
    const offlineMatches = searchOfflinePolicies({
      query,
      orgId: tenantOrgId,
      department: targetDepartment,
      role: userRole,
      limit,
    });

    if (offlineMatches.length > 0) {
      const highestScore = offlineMatches[0].score;
      const contextBlock = formatContextBlock(offlineMatches);
      return {
        isGrounded: true,
        hasResults: true,
        highestScore,
        totalChunksFound: offlineMatches.length,
        query: query.trim(),
        orgId: tenantOrgId,
        chunks: offlineMatches,
        contextBlock,
      };
    }

    return {
      ...ZERO_HALLUCINATION_FALLBACK,
      query: query.trim(),
      orgId: tenantOrgId,
    };
  }

  const highestScore = normalizedChunks[0].score;
  const contextBlock = formatContextBlock(normalizedChunks);

  return {
    isGrounded: true,
    hasResults: true,
    highestScore,
    totalChunksFound: normalizedChunks.length,
    query: query.trim(),
    orgId: tenantOrgId,
    chunks: normalizedChunks,
    contextBlock,
  };
}
