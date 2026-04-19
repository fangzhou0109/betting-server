CREATE DATABASE IF NOT EXISTS betting;
USE betting;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(32) NOT NULL UNIQUE,
  password VARCHAR(200) NOT NULL,
  balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB AUTO_INCREMENT=1000001;

CREATE TABLE IF NOT EXISTS matches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  external_id VARCHAR(64) DEFAULT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  home_team VARCHAR(100) DEFAULT NULL,
  away_team VARCHAR(100) DEFAULT NULL,
  sport_key VARCHAR(64) DEFAULT NULL,
  sport_title VARCHAR(64) DEFAULT NULL,
  start_time DATETIME NOT NULL,
  status ENUM('upcoming', 'live', 'settled') NOT NULL DEFAULT 'upcoming',
  result_odds_id INT DEFAULT NULL,
  source ENUM('manual', 'odds_api') NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sport_key (sport_key),
  INDEX idx_external_id (external_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS odds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  match_id INT NOT NULL,
  label VARCHAR(50) NOT NULL,
  value DECIMAL(8,2) NOT NULL,
  status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (match_id) REFERENCES matches(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  match_id INT NOT NULL,
  odds_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  odds_value DECIMAL(8,2) NOT NULL,
  status ENUM('pending', 'won', 'lost') NOT NULL DEFAULT 'pending',
  payout DECIMAL(12,2) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (match_id) REFERENCES matches(id),
  FOREIGN KEY (odds_id) REFERENCES odds(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type ENUM('deposit', 'bet', 'payout') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  balance_after DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS admin_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NOT NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) DEFAULT NULL,
  target_id INT DEFAULT NULL,
  detail TEXT DEFAULT NULL,
  ip VARCHAR(64) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_id (admin_id),
  INDEX idx_action (action),
  INDEX idx_created (created_at)
) ENGINE=InnoDB;
