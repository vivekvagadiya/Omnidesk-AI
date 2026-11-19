import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Organization } from '../src/models/Organization.model.js';
import { User } from '../src/models/User.model.js';
import { Asset } from '../src/models/Asset.model.js';
import { Ticket } from '../src/models/Ticket.model.js';

export const SEEDED_ACCOUNTS = [
  {
    userId: 'usr_super',
    orgId: 'org_platform',
    name: 'Platform Super Admin',
    email: 'superadmin@omnidesk.ai',
    password: 'SuperPassword123!',
    role: 'super_admin',
    department: 'Platform Operations',
    managerId: null,
    leaveBalances: { casual: 30, sick: 15, maternity: 90 },
  },
  {
    userId: 'usr_org_admin',
    orgId: 'org_abc',
    name: 'Elena Rostova',
    email: 'admin@abctech.com',
    password: 'AdminPassword123!',
    role: 'org_admin',
    department: 'Executive / HR',
    managerId: null,
    leaveBalances: { casual: 20, sick: 10, maternity: 90 },
  },
  {
    userId: 'usr_it_admin',
    orgId: 'org_abc',
    name: 'Marcus Chen',
    email: 'it.admin@abctech.com',
    password: 'ITPassword123!',
    role: 'it_admin',
    department: 'IT Infrastructure',
    managerId: null,
    leaveBalances: { casual: 18, sick: 8, maternity: 90 },
  },
  {
    userId: 'mgr_201',
    orgId: 'org_abc',
    name: 'David Miller',
    email: 'david.m@abctech.com',
    password: 'ManagerPassword123!',
    role: 'manager',
    department: 'Engineering',
    managerId: 'usr_org_admin',
    leaveBalances: { casual: 15, sick: 8, maternity: 90 },
  },
  {
    userId: 'emp_101',
    orgId: 'org_abc',
    name: 'Sarah Jenkins',
    email: 'sarah.j@abctech.com',
    password: 'EmployeePassword123!',
    role: 'employee',
    department: 'Engineering',
    managerId: 'mgr_201', // Reports directly to David Miller
    leaveBalances: { casual: 12, sick: 7, maternity: 90 },
  },
];

async function seed() {
  console.log('🌱 [Seeder] Starting OmniDesk database seeding...');

  const conn = await connectDB();
  if (!conn) {
    console.error('❌ [Seeder] Could not connect to MongoDB. Aborting seed.');
    process.exit(1);
  }

  try {
    // 1. Seed Organization: ABC Technologies
    console.log('🏢 Seeding Organization: ABC Technologies (org_abc)...');
    await Organization.findOneAndUpdate(
      { orgId: 'org_abc' },
      {
        orgId: 'org_abc',
        name: 'ABC Technologies Inc.',
        domain: 'abctech.com',
        status: 'ACTIVE',
      },
      { upsert: true, new: true }
    );

    // 2. Seed Users
    console.log('👥 Seeding Multi-Tier Role Hierarchy Users...');
    for (const acc of SEEDED_ACCOUNTS) {
      const existingUser = await User.findOne({ email: acc.email });
      if (existingUser) {
        existingUser.name = acc.name;
        existingUser.role = acc.role;
        existingUser.department = acc.department;
        existingUser.managerId = acc.managerId;
        existingUser.leaveBalances = acc.leaveBalances;
        existingUser.passwordHash = acc.password; // Pre-save hook will hash
        await existingUser.save();
      } else {
        await User.create({
          userId: acc.userId,
          orgId: acc.orgId,
          name: acc.name,
          email: acc.email,
          passwordHash: acc.password, // Pre-save hook will hash
          role: acc.role,
          department: acc.department,
          managerId: acc.managerId,
          leaveBalances: acc.leaveBalances,
          status: 'ACTIVE',
        });
      }
    }

    // 3. Seed Hardware Assets
    console.log('💻 Seeding Hardware Assets...');
    await Asset.findOneAndUpdate(
      { assetTag: 'HW-MAC-042' },
      {
        assetTag: 'HW-MAC-042',
        orgId: 'org_abc',
        type: 'LAPTOP',
        model: 'MacBook Pro 16" M3 Max (36GB RAM, 1TB SSD)',
        assignedTo: 'emp_101',
        status: 'ASSIGNED',
        cost: 3499,
      },
      { upsert: true }
    );

    await Asset.findOneAndUpdate(
      { assetTag: 'HW-MON-108' },
      {
        assetTag: 'HW-MON-108',
        orgId: 'org_abc',
        type: 'MONITOR',
        model: 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)',
        assignedTo: null,
        status: 'IN_STOCK',
        cost: 799,
      },
      { upsert: true }
    );

    // 4. Seed Support Tickets
    console.log('🎫 Seeding Baseline Tickets...');
    await Ticket.findOneAndUpdate(
      { ticketId: 'TICK-1001' },
      {
        ticketId: 'TICK-1001',
        orgId: 'org_abc',
        userId: 'emp_101',
        title: 'VPN connection timeout on remote network',
        description: 'Unable to connect to internal staging gateway over residential Wi-Fi.',
        category: 'IT_ACCESS',
        priority: 'HIGH',
        status: 'RESOLVED',
        assignedTo: 'usr_it_admin',
      },
      { upsert: true }
    );

    await Ticket.findOneAndUpdate(
      { ticketId: 'TICK-1002' },
      {
        ticketId: 'TICK-1002',
        orgId: 'org_abc',
        userId: 'emp_101',
        title: 'Request for second 4K monitor workstation mount',
        description: 'Ergonomic dual monitor mount for home office setup.',
        category: 'IT_HARDWARE',
        priority: 'MEDIUM',
        status: 'OPEN',
        assignedTo: 'mgr_201',
      },
      { upsert: true }
    );

    console.log('\n================================================================');
    console.log('✅ SEEDING COMPLETE! PRE-CONFIGURED CORPORATE ACCOUNTS:');
    console.log('================================================================');
    console.table(
      SEEDED_ACCOUNTS.map((a) => ({
        Name: a.name,
        Role: a.role,
        Email: a.email,
        Password: a.password,
        Manager: a.managerId || 'None',
        CasualLeaves: a.leaveBalances.casual,
      }))
    );
    console.log('================================================================\n');
  } catch (error) {
    console.error('❌ [Seeder] Error seeding database:', error);
  } finally {
    await disconnectDB();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/seed.js')) {
  seed();
}
