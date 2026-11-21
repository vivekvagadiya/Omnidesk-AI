import { User } from '../../models/User.model.js';

/**
 * Notification rules — the ONE place that decides who hears about what.
 *
 * Each rule receives the event payload and returns a list of notifications to create:
 *   { userId, type, title, body, entity: { kind, id } }
 * The actor never gets a "queue" notification about their own action.
 */

// Which admin roles watch which ticket categories
const CATEGORY_WATCHERS = {
  IT_HARDWARE: ['it_admin'],
  IT_ACCESS: ['it_admin'],
  HR_BENEFITS: ['hr_admin'],
  HR_LEAVE: ['hr_admin'],
  GENERAL: ['org_admin'],
};

const MAX_FANOUT = 200; // hard cap per event

async function findActiveUserIds(filter) {
  const users = await User.find({ ...filter, status: 'ACTIVE' }).select('userId').limit(MAX_FANOUT).lean();
  return users.map((u) => u.userId);
}

async function findManagerId(orgId, userId) {
  const user = await User.findOne({ orgId, userId }).select('managerId').lean();
  return user?.managerId || null;
}

export const notificationRules = {
  /**
   * payload: { orgId, actor: { userId, name }, ticket: { ticketId, title, category, priority } }
   */
  async TICKET_CREATED({ orgId, actor, ticket }) {
    const entity = { kind: 'ticket', id: ticket.ticketId };
    const notes = [
      {
        userId: actor.userId,
        type: 'TICKET_CREATED',
        title: `Ticket ${ticket.ticketId} created`,
        body: `${ticket.title} · ${ticket.priority} priority`,
        entity,
      },
    ];

    const roles = CATEGORY_WATCHERS[ticket.category] || CATEGORY_WATCHERS.GENERAL;
    const watchers = await findActiveUserIds({ orgId, role: { $in: roles } });
    for (const userId of watchers) {
      if (userId === actor.userId) continue;
      notes.push({
        userId,
        type: 'TICKET_ASSIGNED_QUEUE',
        title: `New ${ticket.priority} ticket from ${actor.name || actor.userId}`,
        body: `${ticket.ticketId}: ${ticket.title}`,
        entity,
      });
    }
    return notes;
  },

  /**
   * payload: { orgId, actor, employeeId, employeeName, leaveType, days, startDate, endDate, ticketId, remaining }
   */
  async LEAVE_APPROVED({ orgId, employeeId, employeeName, leaveType, days, startDate, endDate, ticketId, remaining }) {
    const entity = { kind: 'leave', id: ticketId };
    const range = endDate && endDate !== startDate ? `${startDate} → ${endDate}` : startDate;
    const notes = [
      {
        userId: employeeId,
        type: 'LEAVE_APPROVED',
        title: `${days} day(s) of ${leaveType} leave approved`,
        body: `${range} · ${remaining} ${leaveType} day(s) remaining`,
        entity,
      },
    ];

    const managerId = await findManagerId(orgId, employeeId);
    if (managerId && managerId !== employeeId) {
      notes.push({
        userId: managerId,
        type: 'TEAM_LEAVE_APPROVED',
        title: `${employeeName || employeeId} is on ${leaveType} leave`,
        body: `${days} day(s): ${range}`,
        entity,
      });
    }
    return notes;
  },

  /**
   * payload: { orgId, actor, ticket: { ticketId, title, priority } , preferredModel }
   */
  async HARDWARE_REQUESTED({ orgId, actor, ticket, preferredModel }) {
    const entity = { kind: 'ticket', id: ticket.ticketId };
    const notes = [
      {
        userId: actor.userId,
        type: 'HARDWARE_REQUESTED',
        title: `Hardware request ${ticket.ticketId} submitted`,
        body: `${preferredModel} · IT will follow up`,
        entity,
      },
    ];

    const itAdmins = await findActiveUserIds({ orgId, role: 'it_admin' });
    for (const userId of itAdmins) {
      if (userId === actor.userId) continue;
      notes.push({
        userId,
        type: 'HARDWARE_QUEUE',
        title: `Hardware request from ${actor.name || actor.userId}`,
        body: `${preferredModel} · ${ticket.priority} priority`,
        entity,
      });
    }
    return notes;
  },
};
