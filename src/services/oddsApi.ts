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

async function apiFetch<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}apiKey=${config.ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odds API ${res.status}: ${text}`);
  }
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining) {
    console.log(`[OddsAPI] Quota remaining: ${remaining}`);
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
