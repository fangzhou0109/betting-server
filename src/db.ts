import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import config from './config';

export const db = mysql.createPool({
  host: config.MYSQL_HOST,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  database: config.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
});

export const redis = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
});
