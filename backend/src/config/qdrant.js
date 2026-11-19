import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from './environment.js';

let qdrantClient = null;

/**
 * Get or initialize the singleton Qdrant REST client
 * Configured with 768-dim embeddings endpoint for Gemini text-embedding-004
 */
export function getQdrantClient() {
  if (!qdrantClient) {
    qdrantClient = new QdrantClient({
      url: config.qdrant.url,
      checkCompatibility: false,
    });
  }
  return qdrantClient;
}

/**
 * Check connection status and cluster telemetry of Qdrant
 */
export async function checkQdrantHealth() {
  try {
    const client = getQdrantClient();
    const collections = await client.getCollections();
    return {
      connected: true,
      collectionsCount: collections.collections.length,
      url: config.qdrant.url,
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message,
      url: config.qdrant.url,
    };
  }
}
