import type { Db } from '../db.js';
import type { Role } from '../authz/policy.js';

export type NotificationCategory = 'account' | 'security' | 'workflow' | 'gis' | 'system' | 'task' | 'escalation' | 'review' | 'application';

interface Notice {
  category: NotificationCategory;
  title: string;
  body?: string;
  /** In-app path only (validated by the database), e.g. /work/cases/<id>. */
  link?: string;
}

async function enabled(db: Db): Promise<boolean> {
  const { rows: [s] } = await db.query(`SELECT value FROM lais.system_setting WHERE key = 'notifications.in_app_enabled'`);
  return s?.value !== false;
}

/** Creates an in-app notification for each user. Never put passwords, tokens or personal identity data here. */
export async function notifyUsers(db: Db, userIds: (string | null | undefined)[], notice: Notice): Promise<void> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0 || !(await enabled(db))) return;
  await db.query(
    `INSERT INTO lais.notification (user_id, category, title, body, link)
     SELECT unnest($1::uuid[]), $2, $3, $4, $5`,
    [ids, notice.category, notice.title, notice.body ?? null, notice.link ?? null],
  );
}

/** Notifies every active account holding one of the roles (optionally only in one county). */
export async function notifyRoles(db: Db, roles: Role[], notice: Notice, countyId?: number | null): Promise<void> {
  const { rows } = await db.query(
    `SELECT DISTINCT u.id FROM lais.app_user u JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
      WHERE u.status = 'active' AND r.role = ANY($1) AND ($2::smallint IS NULL OR r.county_id IS NULL OR r.county_id = $2)`,
    [roles, countyId ?? null],
  );
  await notifyUsers(db, rows.map((r) => r.id), notice);
}
