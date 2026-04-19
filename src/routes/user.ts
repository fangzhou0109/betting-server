import { Router, Response } from 'express';
import crypto from 'crypto';
import { db, redis } from '../db';
import { hashPassword, verifyPassword } from '../utils/password';
import auth, { AuthRequest } from '../middleware/auth';
import { ResultSetHeader, RowDataPacket } from 'mysql2';

const router = Router();

// 注册
router.post('/register', async (req: AuthRequest, res: Response): Promise<void> => {
  const { username, password } = req.body;

  if (!username || typeof username !== 'string' || username.length < 3 || username.length > 32) {
    res.status(400).json({ error: '用户名需 3-32 个字符' });
    return;
  }
  if (!password || typeof password !== 'string' || password.length < 6 || password.length > 64) {
    res.status(400).json({ error: '密码需 6-64 个字符' });
    return;
  }

  try {
    const hashed = hashPassword(password);
    // 生成随机7位数ID（1000000-9999999），确保不重复
    let uid = 0;
    for (let i = 0; i < 10; i++) {
      uid = 1000000 + Math.floor(Math.random() * 9000000);
      const [exists] = await db.query<RowDataPacket[]>('SELECT id FROM users WHERE id = ?', [uid]);
      if (exists.length === 0) break;
    }
    const [result] = await db.query<ResultSetHeader>(
      'INSERT INTO users (id, username, password, balance) VALUES (?, ?, ?, 0)',
      [uid, username, hashed]
    );
    res.json({ success: true, userId: uid });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '用户名已存在' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// 登录
router.post('/login', async (req: AuthRequest, res: Response): Promise<void> => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: '缺少用户名或密码' });
    return;
  }

  try {
    const [users] = await db.query<RowDataPacket[]>(
      'SELECT id, username, password, balance FROM users WHERE username = ?',
      [username]
    );
    const user = users[0];
    if (!user || !verifyPassword(password, user.password)) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    await redis.set(`token:${token}`, user.id, 'EX', 86400);

    res.json({ success: true, token, userId: user.id, username: user.username, balance: user.balance });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 查询余额
router.get('/balance', auth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await db.query<RowDataPacket[]>('SELECT balance FROM users WHERE id = ?', [req.userId]);
    if (!rows[0]) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    res.json({ balance: rows[0].balance });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 充值
router.post('/deposit', auth, async (req: AuthRequest, res: Response): Promise<void> => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    res.status(400).json({ error: '充值金额需在 0-1000000 之间' });
    return;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [users] = await conn.query<RowDataPacket[]>(
      'SELECT balance FROM users WHERE id = ? FOR UPDATE',
      [req.userId]
    );
    if (!users[0]) throw new Error('用户不存在');

    const newBalance = users[0].balance + amount;
    await conn.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, req.userId]);
    await conn.query(
      "INSERT INTO transactions (user_id, type, amount, balance_after) VALUES (?, 'deposit', ?, ?)",
      [req.userId, amount, newBalance]
    );

    await conn.commit();
    res.json({ success: true, balance: newBalance });
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// 交易流水
router.get('/transactions', auth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, type, amount, balance_after, created_at
       FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ transactions: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
