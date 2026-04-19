import config from '../config';

const BASE_URL = 'https://api.the-odds-api.com/v4';

interface Outcome {
  name: string;
  price: number;
}

interface Market {
  key: string;
  outcomes: Outcome[];
}

interface Bookmaker {
  key: string;
  title: string;
  markets: Market[];
}

export interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Bookmaker[];
}

export interface ScoreEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: { name: string; score: string }[] | null;
}

export interface Sport {
  key: string;
  group: string;
  title: string;
  active: boolean;
}

let quotaPaused = false;

async function apiFetch<T>(path: string): Promise<T> {
  if (quotaPaused) {
    throw new Error('Quota too low, sync paused until next month');
  }
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}apiKey=${config.ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odds API ${res.status}: ${text}`);
  }
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining) {
    const left = parseInt(remaining);
    console.log(`[OddsAPI] Quota remaining: ${left}`);
    if (left < 30) {
      console.warn(`[OddsAPI] Quota critically low (${left}), pausing sync`);
      quotaPaused = true;
    }
  }
  return res.json() as Promise<T>;
}

export async function getSports(): Promise<Sport[]> {
  return apiFetch<Sport[]>('/sports');
}

export async function getOdds(sportKey: string): Promise<OddsEvent[]> {
  return apiFetch<OddsEvent[]>(
    `/sports/${sportKey}/odds?regions=eu,uk&markets=h2h&oddsFormat=decimal`
  );
}

export async function getScores(sportKey: string): Promise<ScoreEvent[]> {
  return apiFetch<ScoreEvent[]>(
    `/sports/${sportKey}/scores?daysFrom=1`
  );
}
