import { Request, Response, NextFunction } from 'express';
import { db, redis } from '../db';
import { RowDataPacket } from 'mysql2';

export interface AdminRequest extends Request {
  adminId?: number;
  adminRole?: string;
}

const ADMIN_ROLES = ['operator', 'admin', 'super_admin'];

export default async function adminAuth(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers['authorization'] as string | undefined;
  if (!token) {
    res.status(401).json({ error: '未登录' });
    return;
  }

  const userId = await redis.get(`token:${token}`);
  if (!userId) {
    res.status(401).json({ error: 'token 无效或已过期' });
    return;
  }

  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT id, role FROM admin_users WHERE id = ? AND status = 1',
    [Number(userId)]
  );
  if (!rows[0] || !ADMIN_ROLES.includes(rows[0].role)) {
    res.status(403).json({ error: '无管理权限' });
    return;
  }

  req.adminId = rows[0].id;
  req.adminRole = rows[0].role;
  next();
}

// 要求 super_admin 角色
export function requireSuperAdmin(req: AdminRequest, res: Response, next: NextFunction): void {
  if (req.adminRole !== 'super_admin') {
    res.status(403).json({ error: '需要超级管理员权限' });
    return;
  }
  next();
}

// 要求 admin 或 super_admin
export function requireAdmin(req: AdminRequest, res: Response, next: NextFunction): void {
  if (req.adminRole !== 'admin' && req.adminRole !== 'super_admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}
