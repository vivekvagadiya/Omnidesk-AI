/**
 * Seed Policies & Offline Knowledge Base for ABC Technologies Inc. (org_abc)
 * Provides pre-structured verified chunks used by Qdrant seeder and as a resilient offline fallback.
 */

export const DEFAULT_ORG_ID = 'org_abc';

export const SEEDED_POLICY_CHUNKS = [
  // --- HR LEAVE POLICY CHUNKS ---
  {
    documentId: 'doc_leave_policy_2026',
    documentName: 'ABC Technologies Leave Policy 2026',
    department: 'HR',
    sectionTitle: 'Casual Leave Guidelines',
    allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    orgId: DEFAULT_ORG_ID,
    keywords: ['casual', 'leave', 'cl', 'vacation', 'time off', 'quota', 'entitlement', 'days', '12 days'],
    text: 'Full-time employees receive 12 casual leaves per calendar year, credited on January 1st. Casual leave is intended for personal matters, emergency family events, or short planned vacations. Casual leave cannot be taken for more than 3 consecutive working days without prior managerial approval. Applications must be submitted via OmniDesk AI at least 48 hours in advance. Unused casual leave balances lapse on December 31st and cannot be encashed or carried forward.',
  },
  {
    documentId: 'doc_leave_policy_2026',
    documentName: 'ABC Technologies Leave Policy 2026',
    department: 'HR',
    sectionTitle: 'Sick Leave Guidelines',
    allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    orgId: DEFAULT_ORG_ID,
    keywords: ['sick', 'illness', 'doctor', 'medical', 'hospital', 'sl', '7 days', 'certificate'],
    text: 'Employees are entitled to 7 days of paid sick leave per calendar year. A recognized medical practitioner certificate is strictly mandatory for any sick leave extending beyond 2 consecutive business days. Employees must notify their manager on the first morning of absence.',
  },
  {
    documentId: 'doc_leave_policy_2026',
    documentName: 'ABC Technologies Leave Policy 2026',
    department: 'HR',
    sectionTitle: 'Maternity and Parental Leave',
    allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    orgId: DEFAULT_ORG_ID,
    keywords: ['maternity', 'paternity', 'parental', 'child', 'birth', 'baby', '90 days', '15 days'],
    text: 'ABC Technologies provides 90 consecutive calendar days of fully paid maternity leave to eligible female employees. Male employees receive 15 days of paid paternity leave within the first 6 months of childbirth or legal adoption. Advance notice of at least 4 weeks is requested.',
  },

  // --- IT HARDWARE & SECURITY CHUNKS ---
  {
    documentId: 'doc_it_policy_2026',
    documentName: 'ABC Technologies IT Hardware Policy 2026',
    department: 'IT',
    sectionTitle: 'Hardware Refresh Cycles',
    allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    orgId: DEFAULT_ORG_ID,
    keywords: ['hardware', 'laptop', 'macbook', 'dell', 'refresh', 'cycle', 'upgrade', '36 months', 'replacement'],
    text: 'Standard engineering workstation refresh cycle is 36 months (3 years) from original provisioning. Eligible engineering employees can request an upgrade to an Apple MacBook Pro 16" (M3/M4 Max with 36GB RAM) or Dell XPS 15 upon completing 36 months of tenure. Upgrades prior to 36 months require technical justification such as battery swelling, thermal throttling, or broken components.',
  },
  {
    documentId: 'doc_it_policy_2026',
    documentName: 'ABC Technologies IT Hardware Policy 2026',
    department: 'IT',
    sectionTitle: 'Peripherals and Workstation Setup',
    allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    orgId: DEFAULT_ORG_ID,
    keywords: ['monitor', 'screen', 'keyboard', 'mouse', 'dock', 'thunderbolt', 'peripherals', 'ultrasharp', '4k'],
    text: 'Employees may request up to two external 4K monitors (Dell UltraSharp 32" U3223QE), ergonomic keyboards, mice, and Thunderbolt 4 docking hubs for home office or corporate office desk setups through OmniDesk support tickets.',
  },
  {
    documentId: 'doc_it_policy_2026',
    documentName: 'ABC Technologies IT Hardware Policy 2026',
    department: 'IT',
    sectionTitle: 'VPN and Remote Access Security',
    allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    orgId: DEFAULT_ORG_ID,
    keywords: ['vpn', 'tailscale', 'globalprotect', 'security', 'remote', 'wifi', 'filevault', 'bitlocker', 'encryption'],
    text: 'All remote access to corporate internal infrastructure requires connection through Tailscale Enterprise or GlobalProtect corporate VPN with Multi-Factor Authentication (MFA). Full disk encryption (FileVault on macOS, BitLocker on Windows) must remain permanently enabled. Unsecured public Wi-Fi is strictly prohibited without active VPN.',
  },

  // --- GENERAL WORKPLACE & BENEFITS CHUNKS ---
  {
    documentId: 'doc_workplace_policy_2026',
    documentName: 'ABC Technologies General Workplace Policy 2026',
    department: 'GENERAL',
    sectionTitle: 'Flexible Working Hours & Hybrid Setup',
    allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    orgId: DEFAULT_ORG_ID,
    keywords: ['hours', 'working', 'hybrid', 'office', 'schedule', 'core hours', 'flexible', 'time'],
    text: 'Standard working hours are 9:00 AM to 6:00 PM local time with core collaboration hours between 10:00 AM and 4:00 PM. Hybrid staff are encouraged to work at least 2 days per week from an ABC corporate office.',
  },
  {
    documentId: 'doc_workplace_policy_2026',
    documentName: 'ABC Technologies General Workplace Policy 2026',
    department: 'GENERAL',
    sectionTitle: 'Wellness and Learning Allowances',
    allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    orgId: DEFAULT_ORG_ID,
    keywords: ['wellness', 'learning', 'allowance', 'stipend', 'gym', 'books', 'courses', 'certifications', 'benefits', '1200', '1500'],
    text: 'ABC Technologies offers an annual wellness allowance of $1,200 ($100 per month) for fitness memberships and mental healthcare, plus an annual learning stipend of $1,500 for technical certifications, conferences, and coursework.',
  },
  {
    documentId: 'doc_workplace_policy_2026',
    documentName: 'ABC Technologies General Workplace Policy 2026',
    department: 'GENERAL',
    sectionTitle: 'Support Ticket SLAs',
    allowedRoles: ['employee', 'manager', 'hr_admin', 'it_admin', 'org_admin'],
    orgId: DEFAULT_ORG_ID,
    keywords: ['sla', 'tickets', 'resolution', 'response', 'critical', 'high', 'priority'],
    text: 'Support ticket SLAs: Critical issues receive an initial response within 1 hour and resolution target within 4 hours. High priority issues are addressed within 4 hours. Medium priority issues have a 2 business day SLA.',
  },
];

/**
 * Resilient Offline Policy Search Function
 * Used when Qdrant is empty or offline to ensure zero runtime errors and continuous RAG functionality.
 *
 * @param {Object} params
 * @param {string} params.query User query text
 * @param {string} [params.orgId] Organization filter
 * @param {string} [params.department] Department filter
 * @param {string} [params.role] Role filter
 * @param {number} [params.limit=3] Maximum chunks to return
 * @returns {Array<Object>}
 */
export function searchOfflinePolicies({
  query = '',
  orgId = DEFAULT_ORG_ID,
  department = null,
  role = null,
  limit = 3,
} = {}) {
  const cleanQuery = query.toLowerCase().trim();
  if (!cleanQuery) return [];

  const queryTerms = cleanQuery
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scored = [];

  for (const chunk of SEEDED_POLICY_CHUNKS) {
    // Tenant check
    if (orgId && chunk.orgId !== orgId && chunk.orgId !== 'org_abc') {
      continue;
    }

    // Department check
    if (department && chunk.department !== 'GENERAL' && chunk.department !== department) {
      continue;
    }

    // Role check
    if (role && Array.isArray(chunk.allowedRoles) && !chunk.allowedRoles.includes(role)) {
      continue;
    }

    let matchCount = 0;
    const lowerText = (chunk.text || '').toLowerCase();
    const lowerSection = (chunk.sectionTitle || 'General Policy').toLowerCase();
    const keywords = Array.isArray(chunk.keywords) ? chunk.keywords : [];

    for (const term of queryTerms) {
      if (lowerText.includes(term)) matchCount += 2;
      if (lowerSection.includes(term)) matchCount += 4;
      if (keywords.some((kw) => kw.includes(term))) matchCount += 3;
    }

    if (matchCount > 0) {
      // Calculate normalized pseudo-similarity score between 0.68 and 0.94
      const normalizedScore = Math.min(0.94, 0.68 + (matchCount * 0.05));

      scored.push({
        chunkId: `off_${chunk.documentId}_${scored.length + 1}`,
        score: Math.round(normalizedScore * 1000) / 1000,
        confidencePercent: Math.round(normalizedScore * 100),
        documentId: chunk.documentId || 'doc_policy',
        documentName: chunk.documentName || 'Company Policy',
        sectionTitle: chunk.sectionTitle || 'General Guidelines',
        text: chunk.text || '',
        department: chunk.department || 'GENERAL',
        allowedRoles: chunk.allowedRoles || ['employee'],
        orgId: chunk.orgId || orgId,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
