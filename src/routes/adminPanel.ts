import { Router, Response, Request } from 'express';
import crypto from 'crypto';
import { db, redis } from '../db';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { verifyPassword, hashPassword } from '../utils/password';
import adminAuth, { AdminRequest, requireSuperAdmin, requireAdmin } from '../middleware/adminAuth';

const router = Router();

// ========== 管理员登录（不需要 adminAuth） ==========
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;
  if (!username || !password) { res.status(400).json({ error: '缺少用户名或密码' }); return; }
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT id, password, role, status FROM admin_users WHERE username = ?', [username]
    );
    const admin = rows[0];
    if (!admin || !verifyPassword(password, admin.password)) {
      res.status(401).json({ error: '用户名或密码错误' }); return;
    }
    if (!admin.status) { res.status(403).json({ error: '账户已被禁用' }); return; }
    const token = crypto.randomBytes(32).toString('hex');
    await redis.set(`token:${token}`, admin.id, 'EX', 86400);
    res.json({ success: true, token, role: admin.role });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// 以下接口需要 adminAuth
router.use(adminAuth);

// ========== 操作日志 ==========
async function logAction(adminId: number, action: string, targetType?: string, targetId?: number, detail?: string, ip?: string) {
  await db.query(
    'INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [adminId, action, targetType || null, targetId || null, detail || null, ip || null]
  );
}

// ========== 仪表盘 ==========
router.get('/dashboard', async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const [[userStats]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) as total, SUM(balance) as totalBalance FROM users');
    const [[matchStats]] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) as total,
        SUM(status='upcoming') as upcoming,
        SUM(status='live') as live,
        SUM(status='settled') as settled
       FROM matches`
    );
    const [[betStats]] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) as total,
        SUM(status='pending') as pending,
        SUM(status='won') as won,
        SUM(status='lost') as lost,
        SUM(amount) as totalAmount,
        SUM(CASE WHEN status='won' THEN payout ELSE 0 END) as totalPayout
       FROM bets`
    );
    const [[txStats]] = await db.query<RowDataPacket[]>(
      `SELECT
        SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END) as totalDeposit,
        SUM(CASE WHEN type='bet' THEN amount ELSE 0 END) as totalBet,
        SUM(CASE WHEN type='payout' THEN amount ELSE 0 END) as totalPayout
       FROM transactions`
    );
    // 今日数据
    const [[todayStats]] = await db.query<RowDataPacket[]>(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURDATE()) as newUsers,
        (SELECT COUNT(*) FROM bets WHERE DATE(created_at) = CURDATE()) as newBets,
        (SELECT COALESCE(SUM(amount),0) FROM bets WHERE DATE(created_at) = CURDATE()) as todayBetAmount,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='deposit' AND DATE(created_at) = CURDATE()) as todayDeposit`
    );

    // 最近7天每日投注量
    const [dailyBets] = await db.query<RowDataPacket[]>(
      `SELECT DATE(created_at) as date, COUNT(*) as count, SUM(amount) as amount
       FROM bets WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at) ORDER BY date`
    );

    // 最近7天每日注册
    const [dailyUsers] = await db.query<RowDataPacket[]>(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at) ORDER BY date`
    );

    // 体育类别投注分布
    const [sportBets] = await db.query<RowDataPacket[]>(
      `SELECT m.sport_key, m.sport_title, COUNT(b.id) as betCount, SUM(b.amount) as betAmount
       FROM bets b JOIN matches m ON b.match_id = m.id
       WHERE m.sport_key IS NOT NULL
       GROUP BY m.sport_key, m.sport_title ORDER BY betAmount DESC`
    );

    res.json({
      users: userStats,
      matches: matchStats,
      bets: betStats,
      transactions: txStats,
      today: todayStats,
      charts: { dailyBets, dailyUsers, sportBets },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 会员管理 ==========
router.get('/users', async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
    const search = (req.query.search as string) || '';
    const sortBy = (req.query.sortBy as string) || 'id';
    const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const minBalance = req.query.minBalance ? Number(req.query.minBalance) : null;
    const maxBalance = req.query.maxBalance ? Number(req.query.maxBalance) : null;
    const startDate = (req.query.startDate as string) || '';
    const endDate = (req.query.endDate as string) || '';
    const riskLevel = (req.query.riskLevel as string) || '';
    const offset = (page - 1) * size;

    let where = '1=1';
    const params: any[] = [];
    if (search) { where += ' AND u.username LIKE ?'; params.push(`%${search}%`); }
    if (minBalance !== null) { where += ' AND u.balance >= ?'; params.push(minBalance); }
    if (maxBalance !== null) { where += ' AND u.balance <= ?'; params.push(maxBalance); }
    if (startDate) { where += ' AND u.created_at >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND u.created_at <= ?'; params.push(endDate + ' 23:59:59'); }

    const [[{ total }]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) as total FROM users u WHERE ${where}`, params);

    // 允许排序的字段白名单
    const allowedSort: Record<string, string> = {
      id: 'u.id', balance: 'u.balance', created_at: 'u.created_at',
      betCount: 'betCount', totalBet: 'totalBet', winRate: 'winRate', netProfit: 'netProfit',
      totalDeposit: 'totalDeposit',
    };
    const orderCol = allowedSort[sortBy] || 'u.id';

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT u.id, u.username, u.balance, u.created_at,
        COALESCE(bet_s.betCount, 0) as betCount,
        COALESCE(bet_s.totalBet, 0) as totalBet,
        COALESCE(bet_s.totalPayout, 0) as totalPayout,
        COALESCE(bet_s.wonCount, 0) as wonCount,
        COALESCE(bet_s.lostCount, 0) as lostCount,
        COALESCE(bet_s.pendingCount, 0) as pendingCount,
        CASE WHEN COALESCE(bet_s.settledCount, 0) > 0 THEN ROUND(COALESCE(bet_s.wonCount, 0) / bet_s.settledCount * 100, 1) ELSE 0 END as winRate,
        COALESCE(bet_s.totalPayout, 0) - COALESCE(bet_s.totalBet, 0) as netProfit,
        COALESCE(bet_s.maxSingleBet, 0) as maxSingleBet,
        COALESCE(bet_s.avgBet, 0) as avgBet,
        COALESCE(bet_s.lastBetTime, NULL) as lastBetTime,
        COALESCE(tx_s.totalDeposit, 0) as totalDeposit,
        COALESCE(tx_s.depositCount, 0) as depositCount,
        COALESCE(tx_s.lastDepositTime, NULL) as lastDepositTime
       FROM users u
       LEFT JOIN (
         SELECT user_id,
           COUNT(*) as betCount,
           SUM(amount) as totalBet,
           SUM(CASE WHEN status='won' THEN payout ELSE 0 END) as totalPayout,
           SUM(status='won') as wonCount,
           SUM(status='lost') as lostCount,
           SUM(status='pending') as pendingCount,
           SUM(status IN ('won','lost')) as settledCount,
           MAX(amount) as maxSingleBet,
           AVG(amount) as avgBet,
           MAX(created_at) as lastBetTime
         FROM bets GROUP BY user_id
       ) bet_s ON bet_s.user_id = u.id
       LEFT JOIN (
         SELECT user_id,
           SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END) as totalDeposit,
           SUM(type='deposit') as depositCount,
           MAX(CASE WHEN type='deposit' THEN created_at ELSE NULL END) as lastDepositTime
         FROM transactions GROUP BY user_id
       ) tx_s ON tx_s.user_id = u.id
       WHERE ${where}
       ORDER BY ${orderCol} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    // 风控标记：高胜率(>70%且注单>10) / 大额投注(单笔>1000) / 高频(日均>20注)
    const enriched = rows.map((r: any) => {
      const risks: string[] = [];
      if (r.winRate > 70 && r.betCount > 10) risks.push('高胜率');
      if (r.maxSingleBet > 1000) risks.push('大额投注');
      const daysActive = Math.max(1, Math.ceil((Date.now() - new Date(r.created_at).getTime()) / 86400000));
      if (r.betCount / daysActive > 20) risks.push('高频投注');
      if (r.netProfit > 5000) risks.push('高盈利');
      return { ...r, risks, riskLevel: risks.length >= 2 ? 'high' : risks.length === 1 ? 'medium' : 'low' };
    });

    // 如果前端过滤风控等级
    const filtered = riskLevel ? enriched.filter((r: any) => r.riskLevel === riskLevel) : enriched;

    // 汇总
    const [[summary]] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) as totalUsers, SUM(balance) as totalBalance,
        (SELECT COUNT(*) FROM users WHERE created_at >= CURDATE()) as todayNew,
        (SELECT COUNT(DISTINCT user_id) FROM bets WHERE created_at >= CURDATE()) as todayActive
       FROM users u WHERE ${where}`, params
    );

    res.json({ total, page, size, users: filtered, summary: summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id/balance', requireAdmin, async (req: AdminRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const { amount, type } = req.body; // type: 'add' | 'set'
  const val = Number(amount);
  if (!Number.isFinite(val) || val < 0) {
    res.status(400).json({ error: '金额无效' });
    return;
  }
  try {
    if (type === 'set') {
      await db.query('UPDATE users SET balance = ? WHERE id = ?', [val, id]);
    } else {
      await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [val, id]);
    }
    await logAction(req.adminId!, 'adjust_balance', 'user', id, `${type}:${val}`, req.ip);
    const [rows] = await db.query<RowDataPacket[]>('SELECT balance FROM users WHERE id = ?', [id]);
    res.json({ success: true, balance: rows[0]?.balance });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id/status', requireAdmin, async (req: AdminRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const { disabled } = req.body;
  // 使用 role 模拟：将 disabled 用户 role 设为特殊值不合适，用 Redis 黑名单
  try {
    const { redis } = await import('../db');
    if (disabled) {
      await redis.set(`user:disabled:${id}`, '1');
    } else {
      await redis.del(`user:disabled:${id}`);
    }
    await logAction(req.adminId!, disabled ? 'disable_user' : 'enable_user', 'user', id, '', req.ip);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 注单查询 ==========
router.get('/bets', async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
    const offset = (page - 1) * size;

    const userId = req.query.userId ? Number(req.query.userId) : null;
    const matchId = req.query.matchId ? Number(req.query.matchId) : null;
    const status = (req.query.status as string) || '';
    const startDate = (req.query.startDate as string) || '';
    const endDate = (req.query.endDate as string) || '';

    let where = '1=1';
    const params: any[] = [];
    if (userId) { where += ' AND b.user_id = ?'; params.push(userId); }
    if (matchId) { where += ' AND b.match_id = ?'; params.push(matchId); }
    if (status) { where += ' AND b.status = ?'; params.push(status); }
    if (startDate) { where += ' AND b.created_at >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND b.created_at <= ?'; params.push(endDate + ' 23:59:59'); }

    const [[{ total }]] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM bets b WHERE ${where}`, params
    );

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT b.id, b.user_id, u.username, b.match_id, m.name as match_name,
              m.home_team, m.away_team, m.sport_key,
              o.label as odds_label, o.market, b.amount, b.odds_value, b.status, b.payout, b.created_at
       FROM bets b
       JOIN users u ON b.user_id = u.id
       JOIN matches m ON b.match_id = m.id
       JOIN odds o ON b.odds_id = o.id
       WHERE ${where}
       ORDER BY b.id DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    // 汇总
    const [[summary]] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) as total, SUM(amount) as totalAmount,
              SUM(CASE WHEN status='won' THEN payout ELSE 0 END) as totalPayout
       FROM bets b WHERE ${where}`, params
    );

    res.json({ total, page, size, bets: rows, summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 赛事管理 ==========
router.get('/matches', async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
    const offset = (page - 1) * size;

    const status = (req.query.status as string) || '';
    const sport = (req.query.sport as string) || '';
    const search = (req.query.search as string) || '';

    let where = '1=1';
    const params: any[] = [];
    if (status) { where += ' AND m.status = ?'; params.push(status); }
    if (sport) { where += ' AND m.sport_key = ?'; params.push(sport); }
    if (search) { where += ' AND (m.name LIKE ? OR m.home_team LIKE ? OR m.away_team LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    const [[{ total }]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) as total FROM matches m WHERE ${where}`, params);

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT m.*,
        (SELECT COUNT(*) FROM bets WHERE match_id = m.id) as betCount,
        (SELECT COALESCE(SUM(amount),0) FROM bets WHERE match_id = m.id) as betAmount,
        JSON_ARRAYAGG(JSON_OBJECT('id', o.id, 'label', o.label, 'value', o.value, 'status', o.status, 'market', o.market, 'point', o.point)) as odds
       FROM matches m LEFT JOIN odds o ON m.id = o.match_id
       WHERE ${where}
       GROUP BY m.id ORDER BY m.start_time DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    res.json({ total, page, size, matches: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/matches/:id', requireAdmin, async (req: AdminRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const { name, startTime, status } = req.body;
  try {
    const updates: string[] = [];
    const params: any[] = [];
    if (name) { updates.push('name = ?'); params.push(name); }
    if (startTime) { updates.push('start_time = ?'); params.push(startTime); }
    if (status) { updates.push('status = ?'); params.push(status); }
    if (updates.length === 0) { res.status(400).json({ error: '无更新内容' }); return; }
    params.push(id);
    await db.query(`UPDATE matches SET ${updates.join(', ')} WHERE id = ?`, params);
    await logAction(req.adminId!, 'update_match', 'match', id, JSON.stringify(req.body), req.ip);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/matches/:id', requireSuperAdmin, async (req: AdminRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  try {
    // 检查是否有关联注单
    const [[{ cnt }]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) as cnt FROM bets WHERE match_id = ?', [id]);
    if (cnt > 0) {
      res.status(400).json({ error: `该比赛有 ${cnt} 笔注单，无法删除` });
      return;
    }
    await db.query('DELETE FROM odds WHERE match_id = ?', [id]);
    await db.query('DELETE FROM matches WHERE id = ?', [id]);
    await logAction(req.adminId!, 'delete_match', 'match', id, '', req.ip);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 报表 ==========
router.get('/reports/revenue', async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const groupBy = (req.query.groupBy as string) || 'day'; // day | week | month

    let dateExpr = 'DATE(created_at)';
    if (groupBy === 'week') dateExpr = "DATE_FORMAT(created_at, '%x-W%v')";
    else if (groupBy === 'month') dateExpr = "DATE_FORMAT(created_at, '%Y-%m')";

    const [daily] = await db.query<RowDataPacket[]>(
      `SELECT ${dateExpr} as date,
        SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END) as deposit,
        SUM(CASE WHEN type='bet' THEN amount ELSE 0 END) as bet,
        SUM(CASE WHEN type='payout' THEN amount ELSE 0 END) as payout,
        COUNT(DISTINCT user_id) as activeUsers,
        COUNT(*) as txCount
       FROM transactions
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY ${dateExpr} ORDER BY date`,
      [days]
    );

    const [summary] = await db.query<RowDataPacket[]>(
      `SELECT
        SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END) as totalDeposit,
        SUM(CASE WHEN type='bet' THEN amount ELSE 0 END) as totalBet,
        SUM(CASE WHEN type='payout' THEN amount ELSE 0 END) as totalPayout,
        COUNT(DISTINCT user_id) as totalActiveUsers,
        COUNT(*) as totalTxCount
       FROM transactions
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [days]
    );

    // 每日新注册
    const [dailyReg] = await db.query<RowDataPacket[]>(
      `SELECT ${dateExpr.replace(/created_at/g, 'u.created_at')} as date, COUNT(*) as count
       FROM users u WHERE u.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY date ORDER BY date`, [days]
    );

    // 每日注单统计
    const [dailyBets] = await db.query<RowDataPacket[]>(
      `SELECT ${dateExpr.replace(/created_at/g, 'b.created_at')} as date,
        COUNT(*) as betCount,
        SUM(b.amount) as betAmount,
        SUM(CASE WHEN b.status='won' THEN b.payout ELSE 0 END) as payoutAmount,
        COUNT(DISTINCT b.user_id) as bettors
       FROM bets b WHERE b.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY date ORDER BY date`, [days]
    );

    res.json({ days, groupBy, daily, summary: summary[0], dailyReg, dailyBets });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports/sports', async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 0));
    let dateFilter = '';
    const params: any[] = [];
    if (days > 0) { dateFilter = 'AND b.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'; params.push(days); }

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT m.sport_key, m.sport_title,
        COUNT(DISTINCT m.id) as matchCount,
        COUNT(b.id) as betCount,
        COUNT(DISTINCT b.user_id) as bettorCount,
        COALESCE(SUM(b.amount), 0) as betAmount,
        COALESCE(SUM(CASE WHEN b.status='won' THEN b.payout ELSE 0 END), 0) as payoutAmount,
        COALESCE(AVG(b.amount), 0) as avgBet,
        COALESCE(MAX(b.amount), 0) as maxBet,
        COALESCE(SUM(b.amount) - SUM(CASE WHEN b.status='won' THEN b.payout ELSE 0 END), 0) as netRevenue,
        CASE WHEN COALESCE(SUM(b.amount), 0) > 0
          THEN ROUND((COALESCE(SUM(b.amount), 0) - COALESCE(SUM(CASE WHEN b.status='won' THEN b.payout ELSE 0 END), 0)) / SUM(b.amount) * 100, 1)
          ELSE 0 END as marginRate
       FROM matches m LEFT JOIN bets b ON b.match_id = m.id ${dateFilter}
       WHERE m.sport_key IS NOT NULL
       GROUP BY m.sport_key, m.sport_title
       ORDER BY betAmount DESC`,
      params
    );

    // 每赛种日趋势
    const [trend] = await db.query<RowDataPacket[]>(
      `SELECT m.sport_key, DATE(b.created_at) as date, COUNT(b.id) as betCount, SUM(b.amount) as betAmount
       FROM bets b JOIN matches m ON b.match_id = m.id
       WHERE m.sport_key IS NOT NULL ${days > 0 ? 'AND b.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)' : ''}
       GROUP BY m.sport_key, DATE(b.created_at) ORDER BY date`,
      days > 0 ? [days] : []
    );

    res.json({ sports: rows, trend });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports/top-users', async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const sortBy = (req.query.sortBy as string) || 'totalBet'; // totalBet | totalWin | netLoss | winRate | betCount
    const days = Number(req.query.days) || 0;

    let dateFilter = '';
    const params: any[] = [];
    if (days > 0) { dateFilter = 'AND b.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'; params.push(days); }

    const allowedSort: Record<string, string> = {
      totalBet: 'totalBet', totalWin: 'totalWin', netLoss: 'netLoss',
      winRate: 'winRate', betCount: 'betCount', balance: 'u.balance',
    };
    const orderCol = allowedSort[sortBy] || 'totalBet';

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT u.id, u.username, u.balance, u.created_at,
        COUNT(b.id) as betCount,
        COALESCE(SUM(b.amount), 0) as totalBet,
        COALESCE(SUM(CASE WHEN b.status='won' THEN b.payout ELSE 0 END), 0) as totalWin,
        COALESCE(SUM(b.amount), 0) - COALESCE(SUM(CASE WHEN b.status='won' THEN b.payout ELSE 0 END), 0) as netLoss,
        CASE WHEN SUM(b.status IN ('won','lost')) > 0 THEN ROUND(SUM(b.status='won') / SUM(b.status IN ('won','lost')) * 100, 1) ELSE 0 END as winRate,
        COALESCE(AVG(b.amount), 0) as avgBet,
        COALESCE(MAX(b.amount), 0) as maxBet,
        MAX(b.created_at) as lastBetTime,
        COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.user_id = u.id AND t.type='deposit'), 0) as totalDeposit
       FROM users u LEFT JOIN bets b ON b.user_id = u.id ${dateFilter}
       GROUP BY u.id ORDER BY ${orderCol} DESC LIMIT ?`,
      [...params, limit]
    );
    res.json({ users: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 权限管理（操作日志） ==========
router.get('/logs', async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
    const offset = (page - 1) * size;

    const [[{ total }]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) as total FROM admin_logs');
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT l.*, u.username as admin_name
       FROM admin_logs l JOIN admin_users u ON l.admin_id = u.id
       ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [size, offset]
    );

    res.json({ total, page, size, logs: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 权限管理（角色列表） ==========
router.get('/roles', async (_req: AdminRequest, res: Response): Promise<void> => {
  res.json({
    roles: [
      { key: 'operator', label: '运营', permissions: ['view_admin', 'view_bets', 'view_users', 'view_matches'] },
      { key: 'admin', label: '管理员', permissions: ['view_admin', 'view_bets', 'view_users', 'manage_matches', 'manage_users', 'settle'] },
      { key: 'super_admin', label: '超级管理员', permissions: ['*'] },
    ],
  });
});

// ========== 后台管理员 CRUD ==========
router.get('/admin-users', requireAdmin, async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
    const offset = (page - 1) * size;
    const search = (req.query.search as string) || '';

    let where = '1=1';
    const params: any[] = [];
    if (search) { where += ' AND username LIKE ?'; params.push(`%${search}%`); }

    const [[{ total }]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) as total FROM admin_users WHERE ${where}`, params);
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, username, role, status, created_at, updated_at FROM admin_users WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );
    res.json({ total, page, size, users: rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/admin-users', requireSuperAdmin, async (req: AdminRequest, res: Response): Promise<void> => {
  const { username, password, role } = req.body;
  if (!username || !password) { res.status(400).json({ error: '用户名和密码必填' }); return; }
  const validRoles = ['operator', 'admin', 'super_admin'];
  if (role && !validRoles.includes(role)) { res.status(400).json({ error: '无效角色' }); return; }
  try {
    const hashed = hashPassword(password);
    await db.query<ResultSetHeader>(
      'INSERT INTO admin_users (username, password, role) VALUES (?, ?, ?)',
      [username, hashed, role || 'operator']
    );
    await logAction(req.adminId!, 'create_admin_user', 'admin_user', undefined, `${username} (${role || 'operator'})`, req.ip);
    res.json({ success: true });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') { res.status(409).json({ error: '用户名已存在' }); return; }
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin-users/:id/role', requireSuperAdmin, async (req: AdminRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const { role } = req.body;
  const validRoles = ['operator', 'admin', 'super_admin'];
  if (!validRoles.includes(role)) { res.status(400).json({ error: '无效角色' }); return; }
  try {
    await db.query('UPDATE admin_users SET role = ? WHERE id = ?', [role, id]);
    await logAction(req.adminId!, 'change_admin_role', 'admin_user', id, `role → ${role}`, req.ip);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/admin-users/:id/status', requireSuperAdmin, async (req: AdminRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const { status } = req.body;
  if (id === req.adminId) { res.status(400).json({ error: '不能禁用自己' }); return; }
  try {
    await db.query('UPDATE admin_users SET status = ? WHERE id = ?', [status ? 1 : 0, id]);
    await logAction(req.adminId!, status ? 'enable_admin' : 'disable_admin', 'admin_user', id, '', req.ip);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/admin-users/:id/password', requireSuperAdmin, async (req: AdminRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const { password } = req.body;
  if (!password || password.length < 6) { res.status(400).json({ error: '密码至少6位' }); return; }
  try {
    const hashed = hashPassword(password);
    await db.query('UPDATE admin_users SET password = ? WHERE id = ?', [hashed, id]);
    await logAction(req.adminId!, 'reset_admin_password', 'admin_user', id, '', req.ip);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
