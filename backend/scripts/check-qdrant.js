import { getQdrantClient, checkQdrantHealth } from '../src/config/qdrant.js';
import {
  POLICY_COLLECTION_NAME,
  initPolicyCollection,
  getCollectionDetails,
} from '../src/services/rag/qdrant.service.js';
import { config } from '../src/config/environment.js';

async function main() {
  console.log('================================================================');
  console.log('🔍 QDRANT VECTOR STORAGE INSPECTOR — OMNIDESK AI');
  console.log('================================================================');
  console.log(`📡 Target URL: ${config.qdrant.url}\n`);

  // 1. Connection check
  const health = await checkQdrantHealth();
  if (!health.connected) {
    console.error('❌ Qdrant is currently NOT reachable at ' + config.qdrant.url);
    console.log('\n💡 To start Qdrant, run either:');
    console.log('   docker compose up -d qdrant    (from C:\\vivek-code\\Omnidesk-AI)');
    console.log('   OR execute qdrant.exe locally.\n');
    console.log('================================================================\n');
    process.exit(1);
  }

  console.log('✅ Connected to Qdrant successfully!');
  const client = getQdrantClient();

  // 2. Fetch all collections
  const collectionsRes = await client.getCollections();
  const collections = collectionsRes.collections || [];

  console.log(`\n📚 Total Collections Found: ${collections.length}`);

  if (collections.length === 0) {
    console.log('   (No collections exist yet)');
  } else {
    collections.forEach((col, idx) => {
      const isTarget = col.name === POLICY_COLLECTION_NAME ? ' ⭐ [Target Policy Collection]' : '';
      console.log(`   ${idx + 1}. ${col.name}${isTarget}`);
    });
  }

  // 3. Inspect target collection: omnidesk_policies
  const targetExists = collections.some((c) => c.name === POLICY_COLLECTION_NAME);

  if (targetExists) {
    console.log(`\n🔎 Inspecting collection '${POLICY_COLLECTION_NAME}':`);
    const details = await getCollectionDetails(client);

    console.log('   Status       :', details.status);
    console.log('   Points Count :', details.points_count ?? details.vectors_count ?? 0);
    console.log('   Vector Size  :', details.config?.params?.vectors?.size || 768);
    console.log('   Distance     :', details.config?.params?.vectors?.distance || 'Cosine');
    console.log('   Segments     :', details.segments_count || 1);
  } else {
    console.log(`\n⚠️  Collection '${POLICY_COLLECTION_NAME}' has not been initialized yet.`);
    
    // Auto-init if --init argument is passed
    if (process.argv.includes('--init')) {
      console.log(`⚙️  Initializing '${POLICY_COLLECTION_NAME}' now...`);
      await initPolicyCollection(client);
      console.log(`✅ Collection '${POLICY_COLLECTION_NAME}' is now initialized and ready!`);
    } else {
      console.log(`👉 Run 'npm run qdrant:init' to create it with 768-dim Cosine vectors and payload indexes.`);
    }
  }

  console.log('\n🌐 Web Dashboard URL: http://localhost:6333/dashboard');
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('💥 Unexpected error:', err.message);
  process.exit(1);
});
