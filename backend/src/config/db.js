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
