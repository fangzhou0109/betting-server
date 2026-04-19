const {
  MYSQL_HOST = 'mysql',
  MYSQL_USER = 'root',
  MYSQL_PASSWORD = 'root123',
  MYSQL_DATABASE = 'betting',
  REDIS_HOST = 'redis',
  REDIS_PORT = '6379',
  PORT = '3000',
  BET_MIN = '1',
  BET_MAX = '100000',
  ODDS_API_KEY = '',
  ODDS_SYNC_INTERVAL = '300000',
  ODDS_SPORTS = 'soccer_epl,basketball_nba,soccer_uefa_champs_league,americanfootball_nfl,baseball_mlb',
} = process.env;

export default {
  MYSQL_HOST,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,
  REDIS_HOST,
  REDIS_PORT: Number(REDIS_PORT),
  PORT: Number(PORT),
  BET_MIN: Number(BET_MIN),
  BET_MAX: Number(BET_MAX),
  ODDS_API_KEY,
  ODDS_SYNC_INTERVAL: Number(ODDS_SYNC_INTERVAL),
  ODDS_SPORTS: ODDS_SPORTS.split(',').map(s => s.trim()),
};
