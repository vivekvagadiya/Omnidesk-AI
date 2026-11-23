import mongoose from 'mongoose';
import { config } from './environment.js';

let isConnected = false;

/**
 * Establish connection to MongoDB with reconnection logic
 */
export async function connectDB() {
  if (isConnected) {
    return mongoose.connection;
  }

  const { uri } = config.mongodb;

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });

    isConnected = true;
    console.log(`🍃 [MongoDB] Connected successfully to host: ${conn.connection.host} (${conn.connection.name})`);

    // Auto-heal any legacy audit log documents with null logId to prevent E11000 duplicate key errors
    try {
      const auditCol = conn.connection.db.collection('auditlogs');
      const nullDocs = await auditCol.find({ logId: null }).toArray();
      if (nullDocs.length > 0) {
        for (const doc of nullDocs) {
          await auditCol.updateOne(
            { _id: doc._id },
            { $set: { logId: `log_${doc._id.toString()}` } }
          );
        }
        console.log(`🍃 [MongoDB] Auto-healed ${nullDocs.length} audit log(s) with missing logId.`);
      }
    } catch {
      // Non-fatal if collection is not yet created
    }

    mongoose.connection.on('error', (err) => {
      console.error('🍃 [MongoDB] Connection runtime error:', err.message);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('🍃 [MongoDB] Disconnected from database.');
      isConnected = false;
    });

    return conn;
  } catch (error) {
    console.error(`❌ [MongoDB] Connection failed (${uri}):`, error.message);
    console.warn('⚠️  [MongoDB] Running in offline mode. Ensure MongoDB is running locally on 27017 or provide MONGODB_URI in .env');
    return null;
  }
}

/**
 * Gracefully close MongoDB connection
 */
export async function disconnectDB() {
  if (isConnected) {
    await mongoose.disconnect();
    isConnected = false;
    console.log('🍃 [MongoDB] Disconnected gracefully.');
  }
}
