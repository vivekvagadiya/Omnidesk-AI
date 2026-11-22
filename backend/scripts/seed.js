import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/config/db.js";
import { Organization } from "../src/models/Organization.model.js";
import { User } from "../src/models/User.model.js";
import { Asset } from "../src/models/Asset.model.js";
import { Ticket } from "../src/models/Ticket.model.js";
import { seedPolicies } from "./seed-policies.js";
import {
  connectRedis,
  disconnectRedis,
  getCacheClient,
  isRedisReady,
} from "../src/config/redis.js";
import { invalidateCachePattern } from "../src/services/cache/cache.service.js";
import { seedBaselineAuditLogs } from "../src/services/audit/audit.service.js";

/** Shared password for every seeded test account */
export const SEED_PASSWORD = "Test@123";

const account = (fields) => ({
  password: SEED_PASSWORD,
  orgId: "org_abc",
  ...fields,
});

/**
 * Test accounts. userId is the stable key: re-running the seed updates these records
 * in place (email, password, role...) instead of creating duplicates.
 *
 * Reporting lines:
 *   Elena (org admin)
 *     └─ David (manager) ── Sarah, James      ← David's "Team / Org" view
 *   Alex (HR admin) ── Priya                   ← NOT on David's team (isolation check)
 *   Marcus (IT admin) — receives IT ticket & hardware notifications
 */
export const SEEDED_ACCOUNTS = [
  account({
    userId: "usr_super",
    orgId: "org_platform",
    name: "Platform Super Admin",
    email: "superadmin@yopmail.com",
    role: "super_admin",
    department: "Platform Operations",
    managerId: null,
    leaveBalances: { casual: 30, sick: 15, maternity: 90 },
  }),
  account({
    userId: "usr_org_admin",
    name: "Elena Rostova",
    email: "elena@yopmail.com",
    role: "org_admin",
    department: "Executive",
    managerId: null,
    leaveBalances: { casual: 20, sick: 10, maternity: 90 },
  }),
  account({
    userId: "usr_it_admin",
    name: "Marcus Vance",
    email: "marcus@yopmail.com",
    role: "it_admin",
    department: "IT Infrastructure",
    managerId: null,
    leaveBalances: { casual: 18, sick: 8, maternity: 90 },
  }),
  account({
    userId: "usr_hr_admin",
    name: "Alex Morgan",
    email: "alex@yopmail.com",
    role: "hr_admin",
    department: "Human Resources",
    managerId: "usr_org_admin",
    leaveBalances: { casual: 18, sick: 8, maternity: 90 },
  }),
  account({
    userId: "mgr_201",
    name: "David Miller",
    email: "david@yopmail.com",
    role: "manager",
    department: "Engineering",
    managerId: "usr_org_admin",
    leaveBalances: { casual: 15, sick: 8, maternity: 90 },
  }),
  account({
    userId: "emp_101",
    name: "Sarah Jenkins",
    email: "sarah@yopmail.com",
    role: "employee",
    department: "Engineering",
    managerId: "mgr_201",
    leaveBalances: { casual: 12, sick: 7, maternity: 90 },
  }),
  account({
    userId: "emp_102",
    name: "James Carter",
    email: "james@yopmail.com",
    role: "employee",
    department: "Engineering",
    managerId: "mgr_201",
    leaveBalances: { casual: 12, sick: 7, maternity: 90 },
  }),
  account({
    userId: "emp_103",
    name: "Priya Sharma",
    email: "priya@yopmail.com",
    role: "employee",
    department: "Human Resources",
    managerId: "usr_hr_admin",
    leaveBalances: { casual: 12, sick: 7, maternity: 90 },
  }),
];

async function seed() {
  console.log("🌱 [Seeder] Starting OmniDesk database seeding...");

  const conn = await connectDB();
  if (!conn) {
    console.error("❌ [Seeder] Could not connect to MongoDB. Aborting seed.");
    process.exit(1);
  }

  try {
    // 1. Seed Organization: ABC Technologies
    console.log("🏢 Seeding Organization: ABC Technologies (org_abc)...");
    await Organization.findOneAndUpdate(
      { orgId: "org_abc" },
      {
        orgId: "org_abc",
        name: "ABC Technologies Inc.",
        domain: "abctech.com",
        status: "ACTIVE",
      },
      { upsert: true, new: true },
    );

    // 2. Seed Users
    console.log("👥 Seeding Multi-Tier Role Hierarchy Users...");
    for (const acc of SEEDED_ACCOUNTS) {
      // An older record with a different userId may still hold this email: free it
      const clash = await User.deleteOne({
        email: acc.email,
        userId: { $ne: acc.userId },
      });
      if (clash.deletedCount) {
        console.log(`   ↺ Removed stale account that held ${acc.email}`);
      }

      let user = await User.findOne({ userId: acc.userId });
      const isNew = !user;
      if (isNew) user = new User({ userId: acc.userId });

      user.set({
        orgId: acc.orgId,
        name: acc.name,
        email: acc.email,
        password: acc.password, // pre-save hook hashes it
        role: acc.role,
        department: acc.department,
        managerId: acc.managerId,
        leaveBalances: acc.leaveBalances,
        status: "ACTIVE",
      });
      // Password changed: sign out any existing sessions for this account
      if (!isNew) user.tokenVersion = (user.tokenVersion || 0) + 1;

      await user.save();
      console.log(`   ${isNew ? "+" : "✓"} ${acc.email} (${acc.role})`);
    }

    // 3. Seed Hardware Assets
    console.log("💻 Seeding Hardware Assets...");
    await Asset.findOneAndUpdate(
      { assetTag: "HW-MAC-042" },
      {
        assetTag: "HW-MAC-042",
        orgId: "org_abc",
        type: "LAPTOP",
        model: 'MacBook Pro 16" M3 Max (36GB RAM, 1TB SSD)',
        assignedTo: "emp_101",
        status: "ASSIGNED",
        cost: 3499,
      },
      { upsert: true },
    );

    await Asset.findOneAndUpdate(
      { assetTag: "HW-MON-108" },
      {
        assetTag: "HW-MON-108",
        orgId: "org_abc",
        type: "MONITOR",
        model: 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)',
        assignedTo: null,
        status: "IN_STOCK",
        cost: 799,
      },
      { upsert: true },
    );

    // 4. Seed Support Tickets
    console.log("🎫 Seeding Baseline Tickets...");
    await Ticket.findOneAndUpdate(
      { ticketId: "TICK-1001" },
      {
        ticketId: "TICK-1001",
        orgId: "org_abc",
        userId: "emp_101",
        title: "VPN connection timeout on remote network",
        description:
          "Unable to connect to internal staging gateway over residential Wi-Fi.",
        category: "IT_ACCESS",
        priority: "HIGH",
        status: "RESOLVED",
        assignedTo: "usr_it_admin",
      },
      { upsert: true },
    );

    await Ticket.findOneAndUpdate(
      { ticketId: "TICK-1002" },
      {
        ticketId: "TICK-1002",
        orgId: "org_abc",
        userId: "emp_101",
        title: "Request for second 4K monitor workstation mount",
        description: "Ergonomic dual monitor mount for home office setup.",
        category: "IT_HARDWARE",
        priority: "MEDIUM",
        status: "OPEN",
        assignedTo: "mgr_201",
      },
      { upsert: true },
    );

    console.log(
      "\n================================================================",
    );
    console.log("✅ SEEDING COMPLETE! PRE-CONFIGURED CORPORATE ACCOUNTS:");
    console.log(
      "================================================================",
    );
    console.table(
      SEEDED_ACCOUNTS.map((a) => ({
        Name: a.name,
        Role: a.role,
        Email: a.email,
        Password: a.password,
        ReportsTo:
          SEEDED_ACCOUNTS.find((m) => m.userId === a.managerId)?.name || "—",
        CasualLeaves: a.leaveBalances.casual,
      })),
    );
    console.log(
      "================================================================\n",
    );

    // 5. Drop cached API responses so reseeded balances/tickets show up immediately
    try {
      await connectRedis({ waitMs: 3000 });
      if (isRedisReady(getCacheClient())) {
        await invalidateCachePattern("cache:*");
        console.log("🧹 Cleared Redis response cache.");
      }
    } catch (cacheErr) {
      console.warn(
        "⚠️ [Seeder] Could not clear Redis cache:",
        cacheErr.message,
      );
    } finally {
      await disconnectRedis();
    }

    // 6. Seed Qdrant Policy Vectors
    try {
      await seedPolicies();
    } catch (policyErr) {
      console.warn(
        "⚠️ [Seeder] Qdrant policy seeding notice:",
        policyErr.message,
      );
    }

    // 7. Seed baseline audit logs
    try {
      await seedBaselineAuditLogs("org_abc");
      console.log("🔒 Baseline audit logs seeded.");
    } catch (auditErr) {
      console.warn("⚠️ [Seeder] Audit log seeding notice:", auditErr.message);
    }
  } catch (error) {
    console.error("❌ [Seeder] Error seeding database:", error);
  } finally {
    await disconnectDB();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/seed.js")) {
  seed();
}
