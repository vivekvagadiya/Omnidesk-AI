import { getQdrantClient } from '../../config/qdrant.js';

export const POLICY_COLLECTION_NAME = 'omnidesk_policies';
export const VECTOR_DIMENSION = 768; // Gemini text-embedding-004
export const DISTANCE_METRIC = 'Cosine';

// Multi-tenant and RBAC payload indexes
export const INDEXED_PAYLOAD_FIELDS = [
  { name: 'orgId', schema: 'keyword' },
  { name: 'department', schema: 'keyword' },
  { name: 'documentId', schema: 'keyword' },
  { name: 'allowedRoles', schema: 'keyword' },
];

/**
 * Idempotently initialize the Qdrant policy collection with 768-dim vectors
 * and configure essential payload indexes for multi-tenant isolation.
 *
 * @param {import('@qdrant/js-client-rest').QdrantClient} [client]
 * @returns {Promise<Object>} Collection details
 */
export async function initPolicyCollection(client = getQdrantClient()) {
  const existsResult = await client.collectionExists(POLICY_COLLECTION_NAME);
  const exists =
    typeof existsResult === 'object' && existsResult !== null
      ? existsResult.exists
      : Boolean(existsResult);

  if (!exists) {
    console.log(
      `🔷 [Qdrant] Initializing collection '${POLICY_COLLECTION_NAME}' (dim=${VECTOR_DIMENSION}, metric=${DISTANCE_METRIC})...`
    );

    await client.createCollection(POLICY_COLLECTION_NAME, {
      vectors: {
        size: VECTOR_DIMENSION,
        distance: DISTANCE_METRIC,
      },
      optimizers_config: {
        default_segment_number: 2,
      },
      replication_factor: 1,
    });

    console.log(`✅ [Qdrant] Collection '${POLICY_COLLECTION_NAME}' created successfully.`);
  } else {
    console.log(`ℹ️  [Qdrant] Collection '${POLICY_COLLECTION_NAME}' already exists.`);
  }

  // Ensure payload indexes exist for multi-tenant filtering and role boundaries
  for (const field of INDEXED_PAYLOAD_FIELDS) {
    try {
      await client.createPayloadIndex(POLICY_COLLECTION_NAME, {
        field_name: field.name,
        field_schema: field.schema,
      });
      console.log(`🔑 [Qdrant] Payload index verified on '${field.name}' (${field.schema})`);
    } catch (indexErr) {
      const msg = indexErr?.message || '';
      if (!msg.toLowerCase().includes('already exists')) {
        console.warn(`⚠️  [Qdrant] Payload index notice on '${field.name}':`, msg);
      }
    }
  }

  return getCollectionDetails(client);
}

/**
 * Retrieve metadata and vector configuration for the policy collection
 *
 * @param {import('@qdrant/js-client-rest').QdrantClient} [client]
 * @returns {Promise<Object>}
 */
export async function getCollectionDetails(client = getQdrantClient()) {
  return client.getCollection(POLICY_COLLECTION_NAME);
}

/**
 * Upsert vector chunks with metadata payloads into Qdrant
 *
 * @param {Array<{ id: string|number, vector: number[], payload: Object }>} points
 * @param {import('@qdrant/js-client-rest').QdrantClient} [client]
 * @returns {Promise<Object>}
 */
export async function upsertPolicyVectors(points, client = getQdrantClient()) {
  if (!Array.isArray(points) || points.length === 0) {
    return { count: 0 };
  }

  return client.upsert(POLICY_COLLECTION_NAME, {
    wait: true,
    points,
  });
}

/**
 * Tenant-isolated vector search with department and role filters
 *
 * @param {Object} params
 * @param {number[]} params.queryVector - 768-dim query embedding
 * @param {string} params.orgId - Tenant organization ID for strict isolation
 * @param {string} [params.department] - Optional department filter
 * @param {string} [params.role] - Optional user role for RBAC filtering
 * @param {number} [params.limit=5] - Number of top chunks to retrieve
 * @param {number} [params.scoreThreshold=0.65] - Zero-hallucination cutoff score
 * @param {import('@qdrant/js-client-rest').QdrantClient} [params.client]
 * @returns {Promise<Array<Object>>} Filtered and scored chunks
 */
export async function searchPolicyVectors({
  queryVector,
  orgId,
  department = null,
  role = null,
  limit = 5,
  scoreThreshold = 0.65,
  client = getQdrantClient(),
}) {
  if (!queryVector || !Array.isArray(queryVector)) {
    throw new Error('queryVector array is required for vector search.');
  }
  if (!orgId) {
    throw new Error('Tenant orgId is required to enforce data isolation.');
  }

  // Tenant isolation is non-negotiable
  const mustConditions = [
    {
      key: 'orgId',
      match: { value: orgId },
    },
  ];

  if (department) {
    mustConditions.push({
      key: 'department',
      match: { value: department },
    });
  }

  if (role) {
    mustConditions.push({
      key: 'allowedRoles',
      match: { value: role },
    });
  }

  // Use modern query API if supported by client
  if (typeof client.query === 'function') {
    const response = await client.query(POLICY_COLLECTION_NAME, {
      query: queryVector,
      filter: {
        must: mustConditions,
      },
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
    });
    return response.points || response;
  }

  // Fallback to search API
  if (typeof client.search === 'function') {
    return client.search(POLICY_COLLECTION_NAME, {
      vector: queryVector,
      filter: {
        must: mustConditions,
      },
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
    });
  }

  throw new Error('No compatible search or query method found on Qdrant client.');
}
