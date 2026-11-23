import app from "./app.js";
import { config } from "./config/environment.js";
import { connectDB, disconnectDB } from "./config/db.js";
import { connectRedis, disconnectRedis } from "./config/redis.js";

let server;

async function bootstrap() {
  console.log(
    "================================================================",
  );
  console.log("🚀 OMNIDESK AI — ENTERPRISE IT & HR OPERATIONS COPILOT BACKEND");
  console.log(
    "================================================================\n",
  );

  // Initialize Database Connections
  await connectDB();
  await connectRedis();

  server = app.listen(config.port, () => {
    console.log(`\n🌐 HTTP Server running on: http://localhost:${config.port}`);
    console.log(
      `📡 Health Check Endpoint : http://localhost:${config.port}/api/health`,
    );
    console.log(
      `🔐 Authentication Endpoint: http://localhost:${config.port}/api/auth/login`,
    );
    console.log(`🌍 Environment            : ${config.nodeEnv}`);
    console.log(
      `================================================================\n`,
    );
  });
}

// Graceful shutdown handler
async function handleShutdown(signal) {
  console.log(
    `\n🛑 [${signal}] Received shutdown signal. Closing server and connections...`,
  );

  if (server) {
    server.close(async () => {
      console.log("🔒 HTTP server closed.");
      await disconnectDB();
      await disconnectRedis();
      console.log("👋 Goodbye!");
      process.exit(0);
    });

    // Force exit if shutdown hangs beyond 10s
    setTimeout(() => {
      console.error("⚠️  Forcefully terminating after 10s timeout.");
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

bootstrap().catch((err) => {
  console.error("💥 Fatal bootstrap error:", err);
  process.exit(1);
});
