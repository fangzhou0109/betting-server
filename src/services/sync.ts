import { db } from '../db';
import config from '../config';
import { getOdds, getScores, OddsEvent } from './oddsApi';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

function averagePrice(event: OddsEvent, outcomeName: string): number {
  const prices: number[] = [];
  for (const bk of event.bookmakers) {
    const h2h = bk.markets.find(m => m.key === 'h2h');
    if (!h2h) continue;
    const outcome = h2h.outcomes.find(o => o.name === outcomeName);
    if (outcome) prices.push(outcome.price);
  }
  if (prices.length === 0) return 2.0;
  return Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
}

function getOutcomeLabels(event: OddsEvent): string[] {
  for (const bk of event.bookmakers) {
    const h2h = bk.markets.find(m => m.key === 'h2h');
    if (h2h) return h2h.outcomes.map(o => o.name);
  }
  return [event.home_team, event.away_team];
}

export async function syncOdds(): Promise<{ synced: number; errors: string[] }> {
  if (!config.ODDS_API_KEY) {
    return { synced: 0, errors: ['ODDS_API_KEY not configured'] };
  }

  let totalSynced = 0;
  const errors: string[] = [];

  for (const sportKey of config.ODDS_SPORTS) {
    try {
      const events = await getOdds(sportKey);
      console.log(`[Sync] ${sportKey}: ${events.length} events`);

      for (const event of events) {
        try {
          await upsertEvent(event);
          totalSynced++;
        } catch (e: any) {
          errors.push(`${event.id}: ${e.message}`);
        }
      }
    } catch (e: any) {
      errors.push(`${sportKey}: ${e.message}`);
    }
  }

  console.log(`[Sync] Done. Synced: ${totalSynced}, Errors: ${errors.length}`);
  return { synced: totalSynced, errors };
}

async function upsertEvent(event: OddsEvent): Promise<void> {
  if (event.bookmakers.length === 0) return;

  const startTime = new Date(event.commence_time)
    .toISOString().slice(0, 19).replace('T', ' ');
  const matchName = `${event.home_team} vs ${event.away_team}`;

  // Check if match exists
  const [existing] = await db.query<RowDataPacket[]>(
    'SELECT id, status FROM matches WHERE external_id = ?',
    [event.id]
  );

  let matchId: number;

  if (existing.length > 0) {
    // Don't update settled matches
    if (existing[0].status === 'settled') return;

    matchId = existing[0].id;

    // Update match info (start_time might change)
    const isLive = new Date(event.commence_time) <= new Date();
    await db.query(
      `UPDATE matches SET name = ?, home_team = ?, away_team = ?,
       start_time = ?, status = ?, sport_title = ?
       WHERE id = ? AND status != 'settled'`,
      [matchName, event.home_team, event.away_team,
       startTime, isLive ? 'live' : 'upcoming', event.sport_title,
       matchId]
    );

    // Update odds values
    const labels = getOutcomeLabels(event);
    for (const label of labels) {
      const avgPrice = averagePrice(event, label);
      await db.query(
        `UPDATE odds SET value = ? WHERE match_id = ? AND label = ? AND status = 'open'`,
        [avgPrice, matchId, label]
      );
    }
  } else {
    // Insert new match
    const isLive = new Date(event.commence_time) <= new Date();
    const [result] = await db.query<ResultSetHeader>(
      `INSERT INTO matches (external_id, name, home_team, away_team, sport_key, sport_title, start_time, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'odds_api')`,
      [event.id, matchName, event.home_team, event.away_team,
       event.sport_key, event.sport_title, startTime, isLive ? 'live' : 'upcoming']
    );
    matchId = result.insertId;

    // Insert odds
    const labels = getOutcomeLabels(event);
    for (const label of labels) {
      const avgPrice = averagePrice(event, label);
      await db.query(
        `INSERT INTO odds (match_id, label, value, status) VALUES (?, ?, ?, 'open')`,
        [matchId, label, avgPrice]
      );
    }
  }
}

export async function syncScores(): Promise<{ settled: number; errors: string[] }> {
  if (!config.ODDS_API_KEY) {
    return { settled: 0, errors: ['ODDS_API_KEY not configured'] };
  }

  let totalSettled = 0;
  const errors: string[] = [];

  for (const sportKey of config.ODDS_SPORTS) {
    try {
      const scores = await getScores(sportKey);
      const completed = scores.filter(s => s.completed && s.scores);

      for (const game of completed) {
        try {
          // Find match
          const [matches] = await db.query<RowDataPacket[]>(
            "SELECT id, status FROM matches WHERE external_id = ? AND status != 'settled'",
            [game.id]
          );
          if (matches.length === 0) continue;

          const matchId = matches[0].id;

          // Determine winner from scores
          if (!game.scores || game.scores.length < 2) continue;
          const homeScore = parseInt(game.scores.find(s => s.name === game.home_team)?.score || '0');
          const awayScore = parseInt(game.scores.find(s => s.name === game.away_team)?.score || '0');

          let winnerName: string;
          if (homeScore > awayScore) {
            winnerName = game.home_team;
          } else if (awayScore > homeScore) {
            winnerName = game.away_team;
          } else {
            winnerName = 'Draw';
          }

          // Find winning odds
          const [odds] = await db.query<RowDataPacket[]>(
            'SELECT id FROM odds WHERE match_id = ? AND label = ?',
            [matchId, winnerName]
          );

          if (odds.length === 0) {
            // If no "Draw" label, skip draw games
            console.log(`[Sync] No odds found for winner "${winnerName}" in match ${matchId}`);
            continue;
          }

          // Auto-settle via admin settle logic
          const { autoSettle } = await import('../routes/admin');
          await autoSettle(matchId, odds[0].id);
          totalSettled++;
          console.log(`[Sync] Auto-settled match ${matchId} (${game.home_team} vs ${game.away_team}), winner: ${winnerName}`);
        } catch (e: any) {
          errors.push(`score ${game.id}: ${e.message}`);
        }
      }
    } catch (e: any) {
      errors.push(`scores ${sportKey}: ${e.message}`);
    }
  }

  return { settled: totalSettled, errors };
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

export function startSyncTimer(): void {
  if (!config.ODDS_API_KEY) {
    console.log('[Sync] ODDS_API_KEY not set, skipping auto-sync');
    return;
  }

  console.log(`[Sync] Starting auto-sync every ${config.ODDS_SYNC_INTERVAL / 1000}s`);

  // Initial sync after 5 seconds (let DB connect first)
  setTimeout(async () => {
    try {
      await syncOdds();
      await syncScores();
    } catch (e: any) {
      console.error('[Sync] Initial sync error:', e.message);
    }
  }, 5000);

  // Periodic sync
  syncTimer = setInterval(async () => {
    try {
      await syncOdds();
      await syncScores();
    } catch (e: any) {
      console.error('[Sync] Periodic sync error:', e.message);
    }
  }, config.ODDS_SYNC_INTERVAL);
}

export function stopSyncTimer(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
