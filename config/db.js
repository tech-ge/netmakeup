const mongoose = require('mongoose');

let isConnected = false;

const connectDB = async () => {
  if (isConnected && mongoose.connection.readyState === 1) return;

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 3,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      w: 'majority',
      bufferCommands: false
    });

    isConnected = true;
    // On Atlas SRV connections, host is the cluster name from the URI
    const dbName = conn.connection.db.databaseName;
    const host   = process.env.MONGODB_URI
      ? process.env.MONGODB_URI.split('@')[1]?.split('/')[0] || 'Atlas'
      : 'unknown';
    console.log(`✅ MongoDB Connected: ${host}`);
    console.log(`📊 Database: ${dbName}`);

  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message);
    isConnected = false;
    throw error;
  }
};

module.exports = connectDB;
