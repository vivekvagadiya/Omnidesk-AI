import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQdrantClient, checkQdrantHealth } from '../src/config/qdrant.js';
import { initPolicyCollection } from '../src/services/rag/qdrant.service.js';
import { ingestDocument } from '../src/services/rag/ingestion.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const POLICIES_DIR = path.resolve(__dirname, '../data/policies');

export async function seedPolicies() {
  console.log('================================================================');
  console.log('📚 OMNIDESK AI — QDRANT POLICY VECTOR SEEDER');
  console.log('================================================================\n');

  const health = await checkQdrantHealth();

  if (!health.connected) {
    console.warn(`⚠️  [Qdrant] Qdrant server is currently NOT reachable at ${health.url}.`);
    console.log('💡 Note: OmniDesk includes an in-memory fallback policy knowledge base');
    console.log('   in `src/services/rag/seedPolicies.data.js`, so policy search works seamlessly');
    console.log('   even when Qdrant is offline.');
    console.log('\n👉 To seed live Qdrant vectors, start Qdrant first:');
    console.log('   docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant\n');
    return false;
  }

  const client = getQdrantClient();
  console.log('✅ Connected to Qdrant!');
  console.log('⚙️  Initializing policy collection and payload indexes...');
  await initPolicyCollection(client);

  const policyFiles = [
    {
      file: 'ABC_Tech_Leave_Policy_2026.md',
      department: 'HR',
      allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    },
    {
      file: 'ABC_Tech_IT_Hardware_and_Security_Policy_2026.md',
      department: 'IT',
      allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    },
    {
      file: 'ABC_Tech_General_Workplace_Policy_2026.md',
      department: 'GENERAL',
      allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    },
  ];

  console.log(`\n📥 Ingesting and embedding ${policyFiles.length} corporate policy documents...`);

  for (const item of policyFiles) {
    const filePath = path.join(POLICIES_DIR, item.file);
    try {
      const buffer = await fs.readFile(filePath);
      console.log(`\n📄 Processing: ${item.file} [Dept: ${item.department}]...`);

      const res = await ingestDocument({
        buffer,
        filename: item.file,
        mimeType: 'text/markdown',
        orgId: 'org_abc',
        department: item.department,
        allowedRoles: item.allowedRoles,
        qdrantClient: client,
      });

      console.log(`   ✅ Ingested: ${res.totalChunks} chunks vectorized and indexed into Qdrant!`);
    } catch (err) {
      console.error(`   ❌ Failed to ingest ${item.file}:`, err.message);
    }
  }

  console.log('\n================================================================');
  console.log('🎉 POLICY SEEDING COMPLETE! Qdrant is populated with corporate policies.');
  console.log('================================================================\n');
  return true;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/seed-policies.js')) {
  seedPolicies()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal policy seed error:', err);
      process.exit(1);
    });
}
