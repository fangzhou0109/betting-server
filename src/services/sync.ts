import { db } from '../db';
import config from '../config';
import { getOdds, getScores, OddsEvent } from './oddsApi';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

function averagePrice(event: OddsEvent, marketKey: string, outcomeName: string): number {
  const prices: number[] = [];
  for (const bk of event.bookmakers) {
    const mkt = bk.markets.find(m => m.key === marketKey);
    if (!mkt) continue;
    const outcome = mkt.outcomes.find(o => o.name === outcomeName);
    if (outcome) prices.push(outcome.price);
  }
  if (prices.length === 0) return 2.0;
  return Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
}

function averagePoint(event: OddsEvent, marketKey: string, outcomeName: string): number | null {
  const points: number[] = [];
  for (const bk of event.bookmakers) {
    const mkt = bk.markets.find(m => m.key === marketKey);
    if (!mkt) continue;
    const outcome = mkt.outcomes.find(o => o.name === outcomeName);
    if (outcome?.point != null) points.push(outcome.point);
  }
  if (points.length === 0) return null;
  return Math.round((points.reduce((a, b) => a + b, 0) / points.length) * 10) / 10;
}

interface MarketOutcome { market: string; label: string; point: number | null; price: number }

function collectMarketOutcomes(event: OddsEvent): MarketOutcome[] {
  const results: MarketOutcome[] = [];
  const marketKeys = ['h2h', 'spreads', 'totals'];

  for (const marketKey of marketKeys) {
    // Collect unique outcome names for this market
    const outcomeNames = new Set<string>();
    for (const bk of event.bookmakers) {
      const mkt = bk.markets.find(m => m.key === marketKey);
      if (!mkt) continue;
      mkt.outcomes.forEach(o => outcomeNames.add(o.name));
    }
    for (const name of outcomeNames) {
      results.push({
        market: marketKey,
        label: name,
        point: averagePoint(event, marketKey, name),
        price: averagePrice(event, marketKey, name),
      });
    }
  }
  return results;
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
      console.error(`[Sync] Error for ${sportKey}: ${e.message}`);
      errors.push(`${sportKey}: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    console.log(`[Sync] Errors detail:`, errors);
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

    // Update or insert odds for all markets
    const outcomes = collectMarketOutcomes(event);
    for (const oc of outcomes) {
      const [existingOdds] = await db.query<RowDataPacket[]>(
        `SELECT id FROM odds WHERE match_id = ? AND market = ? AND label = ? AND (point IS NULL AND ? IS NULL OR point = ?)`,
        [matchId, oc.market, oc.label, oc.point, oc.point]
      );
      if (existingOdds.length > 0) {
        await db.query(
          `UPDATE odds SET value = ?, point = ? WHERE id = ? AND status = 'open'`,
          [oc.price, oc.point, existingOdds[0].id]
        );
      } else {
        await db.query(
          `INSERT INTO odds (match_id, market, label, point, value, status) VALUES (?, ?, ?, ?, ?, 'open')`,
          [matchId, oc.market, oc.label, oc.point, oc.price]
        );
      }
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

    // Insert odds for all markets
    const outcomes = collectMarketOutcomes(event);
    for (const oc of outcomes) {
      await db.query(
        `INSERT INTO odds (match_id, market, label, point, value, status) VALUES (?, ?, ?, ?, ?, 'open')`,
        [matchId, oc.market, oc.label, oc.point, oc.price]
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
