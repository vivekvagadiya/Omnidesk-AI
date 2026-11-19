import {
  validateDocumentFile,
  extractTextFromDocument,
  chunkText,
  generateEmbeddings,
  generateTestEmbedding,
  ingestDocument,
  IngestionValidationError,
  MAX_FILE_SIZE_BYTES,
  VECTOR_DIMENSION,
} from './src/services/rag/ingestion.service.js';

console.log('================================================================');
console.log('📄 OMNIDESK AI — SPRINT 2 MODULE 2: DOCUMENT INGESTION VERIFICATION');
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
// TEST SUITE 1: Week 9 File Validation Guardrails
// =============================================================
console.log('--- Suite 1: File Validation, Anti-Path Traversal & Magic Bytes ---');

// 1.1: File size limit check (Max 10MB)
const oversizedBuffer = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1024);
let oversizedBlocked = false;
try {
  validateDocumentFile({ buffer: oversizedBuffer, filename: 'large_policy.pdf' });
} catch (err) {
  if (err instanceof IngestionValidationError && err.message.includes('10MB limit')) {
    oversizedBlocked = true;
  }
}
assert(oversizedBlocked === true, 'Rejects files exceeding 10MB limit');

// 1.2: Anti-path traversal guardrail
const traversalFilenames = [
  '../../etc/passwd.pdf',
  '..\\..\\windows\\system32\\cmd.pdf',
  'policy\0hidden.pdf',
];
let allTraversalsBlocked = true;
for (const fn of traversalFilenames) {
  try {
    validateDocumentFile({
      buffer: Buffer.from('%PDF-1.4 sample'),
      filename: fn,
    });
    allTraversalsBlocked = false;
  } catch (err) {
    // Expected IngestionValidationError
  }
}
assert(allTraversalsBlocked === true, 'Strictly blocks path traversal sequences in filenames (.., /, \\, null bytes)');

// 1.3: Magic bytes check: Disguised Windows Executable (MZ header)
const fakePdfWithExeHeader = Buffer.from([
  0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00,
]);
let disguisedExeBlocked = false;
try {
  validateDocumentFile({
    buffer: fakePdfWithExeHeader,
    filename: 'annual_bonus.pdf',
  });
} catch (err) {
  if (err.message.includes('Disguised Windows executable binary detected')) {
    disguisedExeBlocked = true;
  }
}
assert(
  disguisedExeBlocked === true,
  'Magic byte header check blocks disguised Windows executable (.exe with MZ header renamed to .pdf)'
);

// 1.4: Magic bytes check: Disguised Linux ELF binary
const fakePdfWithElfHeader = Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00,
]);
let disguisedElfBlocked = false;
try {
  validateDocumentFile({
    buffer: fakePdfWithElfHeader,
    filename: 'it_policy.pdf',
  });
} catch (err) {
  if (err.message.includes('Disguised Linux ELF executable binary detected')) {
    disguisedElfBlocked = true;
  }
}
assert(
  disguisedElfBlocked === true,
  'Magic byte header check blocks disguised Linux ELF binary (.elf renamed to .pdf)'
);

// 1.5: Magic bytes check: Valid PDF (%PDF- header)
const validPdfBuffer = Buffer.from('%PDF-1.4\n%Minimal PDF header for validation');
const pdfValidation = validateDocumentFile({
  buffer: validPdfBuffer,
  filename: 'Employee_Leave_Policy_2026.pdf',
});
assert(
  pdfValidation.fileType === 'pdf' &&
    pdfValidation.sanitizedFilename === 'Employee_Leave_Policy_2026.pdf',
  'Accepts authentic PDF with valid %PDF- magic byte signature'
);

// 1.6: Valid Markdown document
const validMdBuffer = Buffer.from('# IT Security Policy\nAll laptops require FileVault/BitLocker encryption.');
const mdValidation = validateDocumentFile({
  buffer: validMdBuffer,
  filename: 'IT_Security_Policy.md',
});
assert(
  mdValidation.fileType === 'markdown' &&
    mdValidation.sanitizedFilename === 'IT_Security_Policy.md',
  'Accepts valid Markdown document (.md)'
);

// =============================================================
// TEST SUITE 2: Text Extraction (PDF & Markdown)
// =============================================================
console.log('\n--- Suite 2: Text Extraction from Documents ---');

// 2.1: Markdown text extraction
const sampleMarkdown = `# ABC Technologies Leave Policy
## 1. Annual Leave Entitlement
Full-time employees receive 12 casual leaves and 7 sick leaves per calendar year.
## 2. Paternity and Maternity
Maternity leave is provided for 90 days.`;

const extractedMd = await extractTextFromDocument(Buffer.from(sampleMarkdown), 'markdown');
assert(
  extractedMd.includes('12 casual leaves') && extractedMd.includes('Maternity leave'),
  'Extracts clean structured text from Markdown document buffers'
);

// 2.2: PDF text extraction using PDFParse
const samplePdf = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 58 >>\nstream\nBT /F1 12 Tf 72 712 Td (Corporate Laptop Hardware Policy: M3 MacBook Pro) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \n0000000234 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n342\n%%EOF'
);

const extractedPdfText = await extractTextFromDocument(samplePdf, 'pdf');
assert(
  extractedPdfText.includes('Corporate Laptop Hardware Policy'),
  'Extracts text from PDF document buffers using PDFParse'
);
console.log('    ↳ Extracted PDF Snippet:', extractedPdfText.trim());

// =============================================================
// TEST SUITE 3: Sliding-Window Chunking (500 tokens / 50 overlap)
// =============================================================
console.log('\n--- Suite 3: Sliding-Window Chunking & Heading Retention ---');

// Generate multi-section document
const sectionA = new Array(80).fill('leave policy regulations').join(' ');
const sectionB = new Array(80).fill('equipment refresh cycles').join(' ');
const multiSectionDoc = `# Section 1: Leave Guidelines\n${sectionA}\n# Section 2: Hardware Allocations\n${sectionB}`;

const chunks = chunkText(multiSectionDoc, { targetTokens: 40, overlapTokens: 10 });
assert(
  chunks.length >= 2,
  'Splits large document into multiple sequential chunks'
);

assert(
  chunks[0].sectionTitle === 'Section 1: Leave Guidelines' &&
    chunks[chunks.length - 1].sectionTitle === 'Section 2: Hardware Allocations',
  'Preserves contextual section headings across chunks'
);

assert(
  chunks[0].chunkIndex === 0 && chunks[1].chunkIndex === 1,
  'Maintains zero-indexed monotonic chunk ordering'
);
console.log(`    ↳ Generated ${chunks.length} chunks. Chunk 0 tokens: ${chunks[0].tokenCount}, Section: "${chunks[0].sectionTitle}"`);

// =============================================================
// TEST SUITE 4: Gemini 768-dim Vector Embeddings
// =============================================================
console.log('\n--- Suite 4: Vector Embeddings Generation (768 Dimensions) ---');

const testVector = generateTestEmbedding('Test document chunk text for embeddings');
assert(
  Array.isArray(testVector) && testVector.length === VECTOR_DIMENSION,
  `Generates unit vector matching 768-dim Gemini text-embedding-004 standard (${testVector.length} dims)`
);

// Verify batching provider
const sampleTexts = [
  'Casual leave policy details',
  'Sick leave medical certificate requirements',
  'Hardware laptop replacement cycle',
];

const batchVectors = await generateEmbeddings(sampleTexts, {
  batchSize: 2,
  embeddingProvider: generateTestEmbedding,
});

assert(
  batchVectors.length === 3 && batchVectors.every((v) => v.length === 768),
  'Batches multiple texts and returns 768-dim embeddings for all chunks'
);

// =============================================================
// TEST SUITE 5: Full Ingestion Pipeline & Qdrant Upsert
// =============================================================
console.log('\n--- Suite 5: Complete Ingestion Pipeline to Qdrant ---');

let capturedUpsertPoints = null;
const mockQdrantClient = {
  upsert: async (collectionName, { points }) => {
    capturedUpsertPoints = points;
    return { status: 'completed' };
  },
};

const ingestionInput = {
  buffer: Buffer.from(sampleMarkdown),
  filename: 'HR_Leave_Handbook_2026.md',
  mimeType: 'text/markdown',
  orgId: 'org_abc',
  department: 'HR',
  allowedRoles: ['employee', 'manager', 'hr_admin'],
  testEmbeddingProvider: generateTestEmbedding,
  qdrantClient: mockQdrantClient,
};

const ingestionResult = await ingestDocument(ingestionInput);

assert(
  ingestionResult.success === true &&
    ingestionResult.documentName === 'HR_Leave_Handbook_2026.md' &&
    ingestionResult.department === 'HR' &&
    ingestionResult.totalChunks > 0,
  'Successfully executes end-to-end ingestion pipeline for HR policy document'
);

assert(
  Boolean(capturedUpsertPoints) && capturedUpsertPoints.length === ingestionResult.totalChunks,
  'Upserts all generated chunks as vector points into Qdrant'
);

const firstPoint = capturedUpsertPoints[0];
assert(
  firstPoint.vector.length === 768 &&
    firstPoint.payload.orgId === 'org_abc' &&
    firstPoint.payload.department === 'HR' &&
    firstPoint.payload.documentName === 'HR_Leave_Handbook_2026.md' &&
    firstPoint.payload.allowedRoles.includes('employee'),
  'Points payload incorporates multi-tenant orgId, department, allowedRoles, and 768-dim vector'
);

// 5.2 Security check: Ingestion without orgId must throw
let rejectedNoOrg = false;
try {
  await ingestDocument({
    ...ingestionInput,
    orgId: '',
  });
} catch (err) {
  rejectedNoOrg = true;
}
assert(
  rejectedNoOrg === true,
  'Ingestion strictly throws if tenant orgId is omitted (Multi-Tenant Protection)'
);

console.log('\n================================================================');
console.log(`🎉 SPRINT 2 MODULE 2 VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED!`);
console.log('================================================================\n');

process.exit(totalTests === passedTests ? 0 : 1);
