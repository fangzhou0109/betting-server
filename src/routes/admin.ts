import { Router, Request, Response } from 'express';
import { db, redis } from '../db';
import { ResultSetHeader, RowDataPacket } from 'mysql2';

const router = Router();

// 创建比赛
router.post('/match', async (req: Request, res: Response): Promise<void> => {
  const { name, startTime, odds: oddsList } = req.body;

  if (!name || !startTime || !Array.isArray(oddsList) || oddsList.length === 0) {
    res.status(400).json({ error: '缺少 name / startTime / odds' });
    return;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [matchResult] = await conn.query<ResultSetHeader>(
      "INSERT INTO matches (name, start_time, status) VALUES (?, ?, 'upcoming')",
      [name, startTime]
    );
    const matchId = matchResult.insertId;

    for (const o of oddsList) {
      if (!o.label || !Number.isFinite(Number(o.value)) || Number(o.value) <= 0) {
        throw new Error(`赔率数据无效: ${JSON.stringify(o)}`);
      }
      await conn.query(
        "INSERT INTO odds (match_id, label, value, status) VALUES (?, ?, ?, 'open')",
        [matchId, o.label, Number(o.value)]
      );
    }

    await conn.commit();
    res.json({ success: true, matchId });
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// 结算比赛
router.post('/settle', async (req: Request, res: Response): Promise<void> => {
  const { matchId, winningOddsId } = req.body;

  if (!Number.isInteger(matchId) || !Number.isInteger(winningOddsId)) {
    res.status(400).json({ error: '参数无效' });
    return;
  }

  const lockKey = `lock:settle:${matchId}`;
  let conn: Awaited<ReturnType<typeof db.getConnection>> | undefined;

  try {
    const lock = await redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!lock) {
      res.status(429).json({ error: '该比赛正在结算中' });
      return;
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [matches] = await conn.query<RowDataPacket[]>(
      'SELECT status FROM matches WHERE id = ? FOR UPDATE',
      [matchId]
    );
    if (!matches[0]) throw new Error('比赛不存在');
    if (matches[0].status === 'settled') throw new Error('比赛已结算');

    await conn.query(
      "UPDATE matches SET status = 'settled', result_odds_id = ? WHERE id = ?",
      [winningOddsId, matchId]
    );

    await conn.query(
      "UPDATE odds SET status = 'closed' WHERE match_id = ?",
      [matchId]
    );

    const [bets] = await conn.query<RowDataPacket[]>(
      "SELECT id, user_id, amount, odds_value, odds_id FROM bets WHERE match_id = ? AND status = 'pending'",
      [matchId]
    );

    for (const bet of bets) {
      if (bet.odds_id === winningOddsId) {
        const payout = bet.amount * bet.odds_value;

        const [users] = await conn.query<RowDataPacket[]>(
          'SELECT balance FROM users WHERE id = ? FOR UPDATE',
          [bet.user_id]
        );
        const newBalance = users[0].balance + payout;

        await conn.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, bet.user_id]);
        await conn.query("UPDATE bets SET status = 'won', payout = ? WHERE id = ?", [payout, bet.id]);
        await conn.query(
          "INSERT INTO transactions (user_id, type, amount, balance_after) VALUES (?, 'payout', ?, ?)",
          [bet.user_id, payout, newBalance]
        );
      } else {
        await conn.query("UPDATE bets SET status = 'lost', payout = 0 WHERE id = ?", [bet.id]);
      }
    }

    await conn.commit();
    res.json({ success: true, settled: bets.length });
  } catch (err: any) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(400).json({ error: err.message });
  } finally {
    await redis.del(lockKey);
    if (conn) conn.release();
  }
});

// 供 sync 服务调用的自动结算
export async function autoSettle(matchId: number, winningOddsId: number): Promise<void> {
  const lockKey = `lock:settle:${matchId}`;
  let conn: Awaited<ReturnType<typeof db.getConnection>> | undefined;

  try {
    const lock = await redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!lock) throw new Error('settle locked');

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [matches] = await conn.query<RowDataPacket[]>(
      'SELECT status FROM matches WHERE id = ? FOR UPDATE',
      [matchId]
    );
    if (!matches[0]) throw new Error('match not found');
    if (matches[0].status === 'settled') return;

    await conn.query(
      "UPDATE matches SET status = 'settled', result_odds_id = ? WHERE id = ?",
      [winningOddsId, matchId]
    );
    await conn.query(
      "UPDATE odds SET status = 'closed' WHERE match_id = ?",
      [matchId]
    );

    const [bets] = await conn.query<RowDataPacket[]>(
      "SELECT id, user_id, amount, odds_value, odds_id FROM bets WHERE match_id = ? AND status = 'pending'",
      [matchId]
    );

    for (const bet of bets) {
      if (bet.odds_id === winningOddsId) {
        const payout = bet.amount * bet.odds_value;
        const [users] = await conn.query<RowDataPacket[]>(
          'SELECT balance FROM users WHERE id = ? FOR UPDATE',
          [bet.user_id]
        );
        const newBalance = users[0].balance + payout;
        await conn.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, bet.user_id]);
        await conn.query("UPDATE bets SET status = 'won', payout = ? WHERE id = ?", [payout, bet.id]);
        await conn.query(
          "INSERT INTO transactions (user_id, type, amount, balance_after) VALUES (?, 'payout', ?, ?)",
          [bet.user_id, payout, newBalance]
        );
      } else {
        await conn.query("UPDATE bets SET status = 'lost', payout = 0 WHERE id = ?", [bet.id]);
      }
    }

    await conn.commit();
  } catch (err: any) {
    if (conn) await conn.rollback().catch(() => {});
    throw err;
  } finally {
    await redis.del(lockKey);
    if (conn) conn.release();
  }
}

export default router;
