import { Router, Request, Response } from 'express';
import { db } from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

// 比赛列表（支持 sport 筛选）
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const sport = req.query.sport as string | undefined;
    let sql = `SELECT m.id, m.name, m.home_team, m.away_team, m.sport_key, m.sport_title,
                      m.start_time, m.status, m.source,
              JSON_ARRAYAGG(JSON_OBJECT('id', o.id, 'market', o.market, 'label', o.label, 'point', o.point, 'value', o.value, 'status', o.status)) as odds
       FROM matches m
       LEFT JOIN odds o ON m.id = o.match_id`;
    const params: string[] = [];

    if (sport) {
      sql += ' WHERE m.sport_key = ?';
      params.push(sport);
    }

    sql += ' GROUP BY m.id ORDER BY m.start_time';
    const [rows] = await db.query<RowDataPacket[]>(sql, params);
    res.json({ matches: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 可用体育类目
router.get('/sports', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT DISTINCT sport_key, sport_title FROM matches WHERE sport_key IS NOT NULL ORDER BY sport_title`
    );
    res.json({ sports: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
