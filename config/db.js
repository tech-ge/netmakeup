const mongoose = require('mongoose');

let isConnected = false;

const connectDB = async () => {
  if (isConnected) return; // reuse connection in serverless warm instances

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 3,          // safe for serverless — don't exhaust Atlas connections
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      w: 'majority',
      bufferCommands: false    // fail fast, don't buffer when not connected
    });

    isConnected = true;
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    console.log(`📊 Database: ${conn.connection.name}`);

  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message);
    isConnected = false;
    throw error;
  }
};

module.exports = connectDB;