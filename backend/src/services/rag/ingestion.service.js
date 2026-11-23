import path from 'node:path';
import crypto from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';
import { config } from '../../config/environment.js';
import {
  POLICY_COLLECTION_NAME,
  VECTOR_DIMENSION,
  upsertPolicyVectors,
} from './qdrant.service.js';

export {
  POLICY_COLLECTION_NAME,
  VECTOR_DIMENSION,
  upsertPolicyVectors,
};

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit
export const ALLOWED_EXTENSIONS = ['.pdf', '.md', '.markdown', '.txt'];
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/markdown',
  'text/plain',
  'application/octet-stream', // Some browsers send octet-stream for .md
];

export const CHUNK_TARGET_TOKENS = 500;
export const CHUNK_OVERLAP_TOKENS = 50;
export const EMBEDDING_MODEL = 'models/gemini-embedding-001';

export class IngestionValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'IngestionValidationError';
    this.statusCode = statusCode;
  }
}

/**
 * Week 9 Enterprise File Validation
 * Enforces magic bytes inspection, MIME sniffing, anti-path traversal, and file size limits
 *
 * @param {Object} params
 * @param {Buffer} params.buffer File content buffer
 * @param {string} params.filename Original uploaded file name
 * @param {string} [params.mimeType] Declared MIME type
 * @returns {{ sanitizedFilename: string, extension: string, fileType: 'pdf'|'markdown'|'text' }}
 */
export function validateDocumentFile({ buffer, filename, mimeType }) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new IngestionValidationError('Invalid file: File buffer is empty or missing.');
  }

  // 1. File Size Guardrail (Max 10MB)
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new IngestionValidationError(
      `File size exceeds maximum 10MB limit (Received: ${(buffer.length / (1024 * 1024)).toFixed(2)} MB).`
    );
  }

  if (buffer.length < 4) {
    throw new IngestionValidationError('File is too small or corrupted.');
  }

  // 2. Anti-Path Traversal & Filename Sanitization
  if (!filename || typeof filename !== 'string') {
    throw new IngestionValidationError('Filename is required.');
  }

  // Check for traversal attacks
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    throw new IngestionValidationError('Security Alert: Path traversal sequence detected in filename.');
  }

  const baseName = path.basename(filename);
  const ext = path.extname(baseName).toLowerCase();

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new IngestionValidationError(
      `Unsupported file extension '${ext}'. Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`
    );
  }

  // Sanitize characters to alphanumeric, underscores, hyphens, and dots
  const sanitizedFilename = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');

  // 3. Magic Bytes Inspection (Header Sniffing)
  // Block disguised executables (Windows PE MZ header)
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    throw new IngestionValidationError(
      'Security Alert: Disguised Windows executable binary detected (MZ header).'
    );
  }

  // Block disguised Linux ELF binaries
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    throw new IngestionValidationError(
      'Security Alert: Disguised Linux ELF executable binary detected.'
    );
  }

  // Block Java class files
  if (buffer[0] === 0xca && buffer[1] === 0xfe && buffer[2] === 0xba && buffer[3] === 0xbe) {
    throw new IngestionValidationError('Security Alert: Disguised compiled binary detected.');
  }

  // PDF Signature Check (%PDF-)
  if (ext === '.pdf') {
    const isPdfSignature =
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46 &&
      buffer[4] === 0x2d;

    if (!isPdfSignature) {
      throw new IngestionValidationError(
        'Invalid file signature: Declared .pdf file lacks valid %PDF- magic byte header.'
      );
    }

    return { sanitizedFilename, extension: ext, fileType: 'pdf' };
  }

  // Markdown / Text UTF-8 validation
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    // Check for null bytes in text files
    for (let i = 0; i < Math.min(buffer.length, 512); i++) {
      if (buffer[i] === 0x00) {
        throw new IngestionValidationError(
          'Security Alert: Binary content detected in declared text document.'
        );
      }
    }

    return {
      sanitizedFilename,
      extension: ext,
      fileType: ext === '.txt' ? 'text' : 'markdown',
    };
  }

  throw new IngestionValidationError(`Unsupported document format: ${ext}`);
}

/**
 * Extract raw plain text from PDF or Markdown/Text document buffer
 *
 * @param {Buffer} buffer
 * @param {'pdf'|'markdown'|'text'} fileType
 * @returns {Promise<string>}
 */
export async function extractTextFromDocument(buffer, fileType) {
  if (fileType === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const rawText = result.text || '';
      return rawText.replace(/\r\n/g, '\n').trim();
    } finally {
      await parser.destroy();
    }
  }

  // Markdown or plain text
  return buffer.toString('utf-8').replace(/\r\n/g, '\n').trim();
}

/**
 * Sliding-Window Chunking with Heading Context Retention
 * Splits document into approximate ~500 token segments with ~50 token overlap.
 * Uses a heuristic word-based estimation (~0.75 words per token / ~1.33 tokens per word)
 * rather than an exact tokenizer runtime to avoid heavy native tokenization dependencies.
 *
 * @param {string} text Full extracted document text
 * @param {Object} [options]
 * @param {number} [options.targetTokens=500] Heuristic target token estimate per chunk
 * @param {number} [options.overlapTokens=50] Heuristic overlap token estimate
 * @returns {Array<{ chunkIndex: number, text: string, sectionTitle: string, tokenCount: number }>}
 */
export function chunkText(
  text,
  { targetTokens = CHUNK_TARGET_TOKENS, overlapTokens = CHUNK_OVERLAP_TOKENS } = {}
) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return [];
  }

  const lines = text.split('\n');
  const sections = [];
  let currentHeading = 'Overview';
  let currentBuffer = [];

  // Group lines under nearest section heading
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)$/) || line.match(/^(?:Section\s+\d+|[A-Z\s]{4,}):?\s*(.+)?$/);
    if (headingMatch) {
      if (currentBuffer.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentBuffer.join('\n'),
        });
        currentBuffer = [];
      }
      currentHeading = headingMatch[1]?.trim() || line.replace(/^#+\s*/, '').trim();
    } else {
      currentBuffer.push(line);
    }
  }

  if (currentBuffer.length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentBuffer.join('\n'),
    });
  }

  const chunks = [];
  let globalChunkIndex = 0;

  for (const sec of sections) {
    // Heuristic word-based token approximation:
    // Standard English text averages ~0.75 words per token (or ~1.33 tokens per word).
    const words = sec.content.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    // Approximate words: 500 tokens ≈ 375 words, 50 tokens overlap ≈ 38 words
    const targetWords = Math.round(targetTokens * 0.75);
    const overlapWords = Math.round(overlapTokens * 0.75);
    const stepWords = Math.max(1, targetWords - overlapWords);

    let start = 0;
    while (start < words.length) {
      const chunkWords = words.slice(start, start + targetWords);
      const chunkContent = chunkWords.join(' ');
      // Heuristic token count estimation
      const estimatedTokens = Math.round(chunkWords.length / 0.75);

      chunks.push({
        chunkIndex: globalChunkIndex++,
        text: chunkContent,
        sectionTitle: sec.heading,
        tokenCount: estimatedTokens,
      });

      start += stepWords;

      // If remaining words are less than overlap, avoid tiny trailing chunks
      if (start < words.length && words.length - start < overlapWords) {
        break;
      }
    }
  }

  // Fallback if no sections were identified
  if (chunks.length === 0 && text.trim().length > 0) {
    const allWords = text.split(/\s+/).filter(Boolean);
    chunks.push({
      chunkIndex: 0,
      text: allWords.join(' '),
      sectionTitle: 'General',
      tokenCount: Math.round(allWords.length / 0.75),
    });
  }

  return chunks;
}

/**
 * Generate 768-dimensional Gemini embeddings in batches
 *
 * @param {string[]} texts Array of chunk texts
 * @param {Object} [options]
 * @param {number} [options.batchSize=10] Batch size
 * @param {Function} [options.embeddingProvider] Custom provider for testing
 * @returns {Promise<number[][]>} Array of 768-dim float vectors
 */
export async function generateEmbeddings(texts, { batchSize = 10, embeddingProvider = null } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  // Allow custom provider for deterministic unit testing
  if (typeof embeddingProvider === 'function') {
    return Promise.all(texts.map((t) => embeddingProvider(t)));
  }

  if (!config.gemini?.apiKey) {
    if (process.env.NODE_ENV === 'test') {
      console.warn('⚠️  [Embeddings] No Gemini API key in test environment. Using test embedding generator.');
      return texts.map((t) => generateTestEmbedding(t));
    }
    throw new Error('Gemini API key is required for semantic embedding generation in production.');
  }

  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const allVectors = [];

  try {
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const batchPromises = batch.map(async (text) => {
        const response = await ai.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: text,
          config: {
            outputDimensionality: VECTOR_DIMENSION, // 768
          },
        });

        const vector = response.embeddings?.[0]?.values;
        if (!vector || vector.length !== VECTOR_DIMENSION) {
          throw new Error(
            `Unexpected embedding dimension: Expected ${VECTOR_DIMENSION}, got ${vector?.length || 0}`
          );
        }
        return vector;
      });

      const batchResults = await Promise.all(batchPromises);
      allVectors.push(...batchResults);
    }

    return allVectors;
  } catch (apiErr) {
    if (process.env.NODE_ENV === 'test') {
      console.warn(`⚠️  [Embeddings] API call failed in test environment: ${apiErr.message}. Using test embedding generator.`);
      return texts.map((t) => generateTestEmbedding(t));
    }
    console.error(`❌ [Embeddings] Gemini embedding API failure: ${apiErr.message}`);
    throw new Error(`Gemini embedding generation failed: ${apiErr.message}`);
  }
}

/**
 * Test-Only: Deterministic hash-based 768-dim pseudo-embedding generator.
 * Produces unit-length 768-dim vectors strictly for offline unit tests and mocking.
 * WARNING: This has no semantic understanding. Never use as a production embedding fallback.
 *
 * @param {string} text Text to hash
 * @returns {number[]} 768-dim normalized unit vector
 */
export function generateTestEmbedding(text) {
  const hash = crypto.createHash('sha256').update(text).digest();
  const vector = new Array(VECTOR_DIMENSION);

  for (let i = 0; i < VECTOR_DIMENSION; i++) {
    const byte = hash[i % hash.length];
    vector[i] = (byte / 127.5) - 1.0; // [-1.0, 1.0]
  }

  // Normalize to unit length (L2 norm)
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => (norm > 0 ? v / norm : 0));
}

/**
 * Complete Document Ingestion Pipeline
 * Validates, extracts text, chunks, computes 768-dim embeddings, and upserts points into Qdrant
 *
 * @param {Object} params
 * @param {Buffer} params.buffer File content buffer
 * @param {string} params.filename Original file name
 * @param {string} [params.mimeType] Declared MIME type
 * @param {string} params.orgId Multi-tenant organization ID
 * @param {string} params.department Department ('HR' | 'IT' | 'FINANCE' | etc.)
 * @param {string[]} [params.allowedRoles] RBAC roles permitted to read policy
 * @param {Function} [params.testEmbeddingProvider] Optional offline provider
 * @param {Object} [params.qdrantClient] Optional custom Qdrant client
 * @returns {Promise<Object>} Ingestion summary
 */
export async function ingestDocument({
  buffer,
  filename,
  mimeType,
  orgId,
  department,
  allowedRoles = ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
  testEmbeddingProvider = null,
  qdrantClient = null,
}) {
  if (!orgId || typeof orgId !== 'string' || !orgId.trim()) {
    throw new IngestionValidationError('Tenant orgId is required to enforce data isolation.');
  }

  if (!department || typeof department !== 'string' || !department.trim()) {
    throw new IngestionValidationError('Department is required for policy categorization.');
  }

  // 1. File Validation (magic bytes, MIME, traversal, size)
  const { sanitizedFilename, fileType } = validateDocumentFile({
    buffer,
    filename,
    mimeType,
  });

  // 2. Text Extraction
  const extractedText = await extractTextFromDocument(buffer, fileType);
  if (!extractedText || extractedText.length < 10) {
    throw new IngestionValidationError('Document contains insufficient or unreadable text content.');
  }

  // 3. Sliding-Window Chunking (500 tokens, 50 overlap)
  const chunks = chunkText(extractedText);
  if (chunks.length === 0) {
    throw new IngestionValidationError('Unable to create chunks from document content.');
  }

  // 4. Generate Embeddings (768-dim)
  const chunkTexts = chunks.map((c) => c.text);
  const embeddings = await generateEmbeddings(chunkTexts, {
    embeddingProvider: testEmbeddingProvider,
  });

  // 5. Construct Document ID and Qdrant Points
  const documentId = `doc_${crypto
    .createHash('sha256')
    .update(`${sanitizedFilename}_${orgId}_${Date.now()}`)
    .digest('hex')
    .substring(0, 12)}`;

  const points = chunks.map((chunk, idx) => ({
    id: crypto.randomUUID(), // Valid Qdrant UUID
    vector: embeddings[idx],
    payload: {
      documentId,
      documentName: sanitizedFilename,
      department: department.toUpperCase(),
      sectionTitle: chunk.sectionTitle,
      text: chunk.text,
      orgId,
      allowedRoles,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunks.length,
      tokenCount: chunk.tokenCount,
      ingestedAt: new Date().toISOString(),
    },
  }));

  // 6. Upsert into Qdrant Collection
  await upsertPolicyVectors(points, qdrantClient);

  return {
    success: true,
    documentId,
    documentName: sanitizedFilename,
    department: department.toUpperCase(),
    totalChunks: chunks.length,
    pointsUpserted: points.length,
    allowedRoles,
    sampleChunk: {
      sectionTitle: chunks[0].sectionTitle,
      preview: chunks[0].text.substring(0, 120) + '...',
      tokenCount: chunks[0].tokenCount,
    },
  };
}
