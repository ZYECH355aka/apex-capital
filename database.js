// config/database.js
const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST || 'localhost',
      port:     parseInt(process.env.DB_PORT) || 3306,
      user:     process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'apex_capital',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: '+00:00',
    });
  }
  return pool;
}

async function query(sql, params = []) {
  const p = await getPool();
  const [rows] = await p.execute(sql, params);
  return rows;
}

// ── CREATE ALL TABLES ──────────────────────────────────────────
async function initDB() {
  const conn = await (await getPool()).getConnection();
  try {
    // Users
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id          VARCHAR(36) PRIMARY KEY,
        first_name  VARCHAR(100) NOT NULL,
        last_name   VARCHAR(100) NOT NULL,
        email       VARCHAR(255) UNIQUE NOT NULL,
        phone       VARCHAR(30),
        password    VARCHAR(255) NOT NULL,
        role        ENUM('user','admin') DEFAULT 'user',
        status      ENUM('active','suspended') DEFAULT 'active',
        cash_balance     DECIMAL(18,2) DEFAULT 0.00,
        invested_balance DECIMAL(18,2) DEFAULT 0.00,
        total_deposited  DECIMAL(18,2) DEFAULT 0.00,
        total_withdrawn  DECIMAL(18,2) DEFAULT 0.00,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Deposit requests
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS deposit_requests (
        id            VARCHAR(36) PRIMARY KEY,
        user_id       VARCHAR(36) NOT NULL,
        amount        DECIMAL(18,2) NOT NULL,
        reference     VARCHAR(100) NOT NULL COMMENT 'Bank transfer reference',
        sender_name   VARCHAR(200) NOT NULL,
        sender_bank   VARCHAR(200) NOT NULL,
        proof_file    VARCHAR(500) COMMENT 'Path to uploaded proof',
        notes         TEXT,
        status        ENUM('pending','approved','rejected') DEFAULT 'pending',
        admin_note    TEXT,
        reviewed_by   VARCHAR(36),
        reviewed_at   DATETIME,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Withdrawal requests
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id              VARCHAR(36) PRIMARY KEY,
        user_id         VARCHAR(36) NOT NULL,
        amount          DECIMAL(18,2) NOT NULL,
        bank_name       VARCHAR(200) NOT NULL,
        account_name    VARCHAR(200) NOT NULL,
        account_number  VARCHAR(100) NOT NULL,
        routing_number  VARCHAR(50),
        swift_code      VARCHAR(20),
        notes           TEXT,
        status          ENUM('pending','approved','processing','completed','rejected') DEFAULT 'pending',
        admin_note      TEXT,
        reviewed_by     VARCHAR(36),
        reviewed_at     DATETIME,
        completed_at    DATETIME,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Transactions ledger (immutable record)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id          VARCHAR(36) PRIMARY KEY,
        user_id     VARCHAR(36) NOT NULL,
        type        ENUM('deposit','withdrawal','investment','return','fee','adjustment') NOT NULL,
        amount      DECIMAL(18,2) NOT NULL,
        balance_after DECIMAL(18,2) NOT NULL,
        reference_id  VARCHAR(36) COMMENT 'deposit/withdrawal request id',
        description TEXT,
        status      ENUM('pending','completed','failed') DEFAULT 'completed',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Investments
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS investments (
        id          VARCHAR(36) PRIMARY KEY,
        user_id     VARCHAR(36) NOT NULL,
        product_id  VARCHAR(50) NOT NULL,
        product_name VARCHAR(200) NOT NULL,
        principal   DECIMAL(18,2) NOT NULL,
        current_value DECIMAL(18,2) NOT NULL,
        return_rate DECIMAL(5,4) NOT NULL COMMENT 'Annual rate as decimal e.g. 0.18',
        status      ENUM('active','matured','withdrawn') DEFAULT 'active',
        maturity_date DATE,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Notifications
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id        VARCHAR(36) PRIMARY KEY,
        user_id   VARCHAR(36) NOT NULL,
        title     VARCHAR(255) NOT NULL,
        message   TEXT NOT NULL,
        type      ENUM('info','success','warning','error') DEFAULT 'info',
        is_read   TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('✅ Database tables initialized');
  } finally {
    conn.release();
  }
}

module.exports = { query, getPool, initDB };
