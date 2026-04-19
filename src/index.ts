import express, { Request, Response } from 'express';
import config from './config';
import { db, redis } from './db';

import userRoutes from './routes/user';
import betRoutes from './routes/bet';
import matchRoutes from './routes/match';
import adminRoutes from './routes/admin';
import adminPanelRoutes from './routes/adminPanel';
import { syncOdds, syncScores, startSyncTimer } from './services/sync';

const app = express();
app.use(express.json());

// 健康检查
app.get('/', async (_req: Request, res: Response) => {
  try {
    const [rows] = await db.query('SELECT NOW() as time') as any;
    await redis.set('ping', 'pong');
    res.json({ mysql: rows[0], redis: 'ok' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 路由挂载
app.use('/', userRoutes);
app.use('/bet', betRoutes);
app.use('/bets', betRoutes);
app.use('/matches', matchRoutes);
app.use('/admin', adminRoutes);
app.use('/mgmt', adminPanelRoutes);

// 手动触发同步
app.post('/admin/sync', async (_req: Request, res: Response) => {
  try {
    const oddsResult = await syncOdds();
    const scoresResult = await syncScores();
    res.json({ odds: oddsResult, scores: scoresResult });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(config.PORT, () => {
  console.log(`Server running on ${config.PORT}`);
  startSyncTimer();
});
