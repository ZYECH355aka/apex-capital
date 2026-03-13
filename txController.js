// controllers/txController.js
const { query } = require('../config/database');

// GET /api/transactions
async function getTransactions(req, res) {
  try {
    const { type, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT * FROM transactions WHERE user_id=?';
    const params = [req.user.id];
    if (type) { sql += ' AND type=?'; params.push(type); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    const rows = await query(sql, params);

    const [[{ total }]] = [await query(
      `SELECT COUNT(*) as total FROM transactions WHERE user_id=?${type ? ' AND type=?' : ''}`,
      type ? [req.user.id, type] : [req.user.id]
    )];
    res.json({ transactions: rows, total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions.' });
  }
}

// GET /api/notifications
async function getNotifications(req, res) {
  try {
    const rows = await query(
      'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    const [[{ unread }]] = [await query(
      'SELECT COUNT(*) as unread FROM notifications WHERE user_id=? AND is_read=0',
      [req.user.id]
    )];
    res.json({ notifications: rows, unread });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch notifications.' });
  }
}

// PUT /api/notifications/read-all
async function markAllRead(req, res) {
  try {
    await query('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id]);
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
}

// GET /api/dashboard  — single call for all dashboard data
async function dashboard(req, res) {
  try {
    const uid = req.user.id;
    const [[user]] = [await query(
      `SELECT cash_balance, invested_balance, total_deposited, total_withdrawn FROM users WHERE id=?`, [uid]
    )];
    const recentTx = await query(
      'SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 10', [uid]
    );
    const pendingDeposits = await query(
      'SELECT id, amount, reference, status, created_at FROM deposit_requests WHERE user_id=? AND status="pending"', [uid]
    );
    const pendingWithdrawals = await query(
      'SELECT id, amount, bank_name, status, created_at FROM withdrawal_requests WHERE user_id=? AND status IN ("pending","processing")', [uid]
    );
    const [[{ unread }]] = [await query(
      'SELECT COUNT(*) as unread FROM notifications WHERE user_id=? AND is_read=0', [uid]
    )];
    res.json({ user, recentTx, pendingDeposits, pendingWithdrawals, unread });
  } catch (err) {
    res.status(500).json({ error: 'Dashboard fetch failed.' });
  }
}

// GET /api/admin/dashboard — admin stats
async function adminDashboard(req, res) {
  try {
    const [[stats]] = [await query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='user') as total_users,
        (SELECT COUNT(*) FROM deposit_requests WHERE status='pending') as pending_deposits,
        (SELECT COUNT(*) FROM withdrawal_requests WHERE status='pending') as pending_withdrawals,
        (SELECT COALESCE(SUM(amount),0) FROM deposit_requests WHERE status='approved') as total_deposited,
        (SELECT COALESCE(SUM(amount),0) FROM withdrawal_requests WHERE status IN ('completed')) as total_withdrawn,
        (SELECT COALESCE(SUM(cash_balance+invested_balance),0) FROM users WHERE role='user') as total_aum
    `)];
    const recentDeposits = await query(
      `SELECT dr.*,u.email,u.first_name,u.last_name FROM deposit_requests dr
       JOIN users u ON dr.user_id=u.id ORDER BY dr.created_at DESC LIMIT 10`
    );
    const recentWithdrawals = await query(
      `SELECT wr.*,u.email,u.first_name,u.last_name FROM withdrawal_requests wr
       JOIN users u ON wr.user_id=u.id ORDER BY wr.created_at DESC LIMIT 10`
    );
    res.json({ stats, recentDeposits, recentWithdrawals });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
}

module.exports = { getTransactions, getNotifications, markAllRead, dashboard, adminDashboard };
