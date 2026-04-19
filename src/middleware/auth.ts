import { Request, Response, NextFunction } from 'express';
import { redis } from '../db';

export interface AuthRequest extends Request {
  userId?: number;
}

export default async function auth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
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

  req.userId = Number(userId);
  next();
}
