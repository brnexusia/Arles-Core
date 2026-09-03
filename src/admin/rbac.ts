import { db } from '../infrastructure/db.js';

export async function hasAdminPermission(userId: string, required: string): Promise<boolean> {
  const result = await db.query<{ permissions: string[] | null }>(
    `select permissions from auth_users where id=$1 and role='admin' limit 1`,
    [userId]
  );
  const permissions = result.rows[0]?.permissions ?? [];
  if (permissions.includes('admin.*') || permissions.includes(required)) return true;

  const parts = required.split('.');
  while (parts.length > 1) {
    parts.pop();
    if (permissions.includes(`${parts.join('.')}.*`)) return true;
  }
  return false;
}
