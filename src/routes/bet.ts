import { Router, Response } from 'express';
import { db, redis } from '../db';
import config from '../config';
import auth, { AuthRequest } from '../middleware/auth';
import { RowDataPacket } from 'mysql2';

const router = Router();

// 下注
router.post('/', auth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { matchId, oddsId } = req.body;
  const amount = Number(req.body.amount);
  const userId = req.userId!;

  if (!Number.isInteger(matchId) || matchId <= 0) {
    res.status(400).json({ error: 'matchId 无效' });
    return;
  }
  if (!Number.isInteger(oddsId) || oddsId <= 0) {
    res.status(400).json({ error: 'oddsId 无效' });
    return;
  }
  if (!Number.isFinite(amount) || amount < config.BET_MIN || amount > config.BET_MAX) {
    res.status(400).json({ error: `下注金额需在 ${config.BET_MIN}-${config.BET_MAX} 之间` });
    return;
  }
  if (Math.round(amount * 100) !== amount * 100) {
    res.status(400).json({ error: '金额最多两位小数' });
    return;
  }

  const lockKey = `lock:user:${userId}`;
  let conn: Awaited<ReturnType<typeof db.getConnection>> | undefined;

  try {
    const lock = await redis.set(lockKey, '1', 'EX', 5, 'NX');
    if (!lock) {
      res.status(429).json({ error: '操作太频繁' });
      return;
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    // 1. 锁用户
    const [users] = await conn.query<RowDataPacket[]>(
      'SELECT balance FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    const user = users[0];
    if (!user) throw new Error('用户不存在');
    if (user.balance < amount) throw new Error('余额不足');

    // 2. 取赔率（加行锁）
    const [odds] = await conn.query<RowDataPacket[]>(
      'SELECT value, match_id, status FROM odds WHERE id = ? FOR UPDATE',
      [oddsId]
    );
    const odd = odds[0];
    if (!odd) throw new Error('赔率不存在');
    if (odd.status !== 'open') throw new Error('该赔率已关闭');
    if (odd.match_id !== matchId) throw new Error('赔率与比赛不匹配');

    // 3. 校验比赛状态
    const [matches] = await conn.query<RowDataPacket[]>(
      'SELECT status FROM matches WHERE id = ?',
      [matchId]
    );
    if (!matches[0]) throw new Error('比赛不存在');
    if (matches[0].status !== 'upcoming') throw new Error('比赛不可投注');

    const newBalance = user.balance - amount;

    // 4. 扣钱
    await conn.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);

    // 5. 写下注
    await conn.query(
      `INSERT INTO bets (user_id, match_id, odds_id, amount, odds_value, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [userId, matchId, oddsId, amount, odd.value]
    );

    // 6. 写流水
    await conn.query(
      "INSERT INTO transactions (user_id, type, amount, balance_after) VALUES (?, 'bet', ?, ?)",
      [userId, -amount, newBalance]
    );

    await conn.commit();
    res.json({ success: true, balance: newBalance });

  } catch (err: any) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(400).json({ error: err.message });
  } finally {
    await redis.del(lockKey);
    if (conn) conn.release();
  }
});

// 下注记录
router.get('/', auth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT b.id, b.match_id, b.odds_id, b.amount, b.odds_value, b.status, b.created_at,
              m.name as match_name
       FROM bets b
       LEFT JOIN matches m ON b.match_id = m.id
       WHERE b.user_id = ?
       ORDER BY b.created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ bets: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
