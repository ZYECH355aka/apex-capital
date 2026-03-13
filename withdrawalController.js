// controllers/withdrawalController.js
const { v4: uuidv4 } = require('uuid');
const { query, getPool } = require('../config/database');

// POST /api/withdrawals/request
async function createRequest(req, res) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const { amount, bank_name, account_name, account_number, routing_number, swift_code, notes } = req.body;

    if (!amount || isNaN(amount) || parseFloat(amount) < 50)
      return res.status(400).json({ error: 'Minimum withdrawal is $50.' });
    if (!bank_name || !account_name || !account_number)
      return res.status(400).json({ error: 'Bank name, account name, and account number are required.' });

    const parsedAmount = parseFloat(amount);

    await conn.beginTransaction();

    // Lock user row and check balance
    const [[user]] = await conn.execute(
      'SELECT cash_balance FROM users WHERE id=? FOR UPDATE',
      [req.user.id]
    );
    if (user.cash_balance < parsedAmount)
      return res.status(400).json({ error: `Insufficient balance. Available: $${parseFloat(user.cash_balance).toFixed(2)}` });

    // Daily limit check
    const [[{ daily_total }]] = await conn.execute(
      `SELECT COALESCE(SUM(amount),0) AS daily_total
       FROM withdrawal_requests
       WHERE user_id=? AND status NOT IN ('rejected') AND DATE(created_at)=CURDATE()`,
      [req.user.id]
    );
    if (parseFloat(daily_total) + parsedAmount > 50000) {
      await conn.rollback();
      return res.status(400).json({ error: 'Exceeds daily withdrawal limit of $50,000.' });
    }

    // Deduct balance immediately (funds held)
    await conn.execute(
      'UPDATE users SET cash_balance = cash_balance - ? WHERE id=?',
      [parsedAmount, req.user.id]
    );

    const [[updated]] = await conn.execute('SELECT cash_balance FROM users WHERE id=?', [req.user.id]);

    // Create request
    const id = uuidv4();
    await conn.execute(
      `INSERT INTO withdrawal_requests
         (id, user_id, amount, bank_name, account_name, account_number, routing_number, swift_code, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, parsedAmount, bank_name, account_name, account_number,
       routing_number || null, swift_code || null, notes || null]
    );

    // Ledger — pending
    await conn.execute(
      `INSERT INTO transactions (id, user_id, type, amount, balance_after, reference_id, description, status)
       VALUES (?, ?, 'withdrawal', ?, ?, ?, ?, 'pending')`,
      [uuidv4(), req.user.id, -parsedAmount, updated.cash_balance, id,
       `Withdrawal request to ${bank_name} — ${account_name}`]
    );

    // Notify user
    await conn.execute(
      `INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, 'info')`,
      [uuidv4(), req.user.id,
       'Withdrawal Request Received',
       `Your withdrawal of $${parsedAmount.toLocaleString()} is under review. Funds held from your balance.`]
    );

    await conn.commit();
    console.log(`💸 New withdrawal request #${id} — $${parsedAmount} from ${req.user.email}`);

    res.status(201).json({ message: 'Withdrawal request submitted. Pending admin approval.', request_id: id });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Failed to submit withdrawal request.' });
  } finally {
    conn.release();
  }
}

// GET /api/withdrawals/my
async function myRequests(req, res) {
  try {
    const rows = await query(
      `SELECT id, amount, bank_name, account_name, account_number, status, admin_note, created_at, reviewed_at, completed_at
       FROM withdrawal_requests WHERE user_id=? ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch withdrawal history.' });
  }
}

// ── ADMIN ────────────────────────────────────────────────────────

// GET /api/withdrawals/admin/all
async function adminGetAll(req, res) {
  try {
    const { status } = req.query;
    let sql = `
      SELECT wr.*, u.email, u.first_name, u.last_name
      FROM withdrawal_requests wr JOIN users u ON wr.user_id=u.id
    `;
    const params = [];
    if (status) { sql += ' WHERE wr.status=?'; params.push(status); }
    sql += ' ORDER BY wr.created_at DESC';
    res.json({ requests: await query(sql, params) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests.' });
  }
}

// POST /api/withdrawals/admin/approve/:id
async function adminApprove(req, res) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[wr]] = await conn.execute(
      'SELECT * FROM withdrawal_requests WHERE id=? AND status="pending"',
      [req.params.id]
    );
    if (!wr) { await conn.rollback(); return res.status(404).json({ error: 'Not found or already processed.' }); }

    await conn.execute(
      `UPDATE withdrawal_requests SET status='processing', admin_note=?, reviewed_by=?, reviewed_at=NOW() WHERE id=?`,
      [req.body.admin_note || null, req.user.id, wr.id]
    );

    // Update ledger to processing
    await conn.execute(
      `UPDATE transactions SET status='completed' WHERE reference_id=? AND type='withdrawal'`,
      [wr.id]
    );

    // Update total_withdrawn
    await conn.execute(
      'UPDATE users SET total_withdrawn=total_withdrawn+? WHERE id=?',
      [wr.amount, wr.user_id]
    );

    await conn.execute(
      `INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, 'success')`,
      [uuidv4(), wr.user_id,
       'Withdrawal Approved ✓',
       `Your withdrawal of $${parseFloat(wr.amount).toLocaleString()} has been approved and is being transferred to your bank.`]
    );

    await conn.commit();
    res.json({ message: 'Withdrawal approved and marked as processing.' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Approval failed.' });
  } finally {
    conn.release();
  }
}

// POST /api/withdrawals/admin/complete/:id
async function adminComplete(req, res) {
  try {
    const [wr] = await query('SELECT * FROM withdrawal_requests WHERE id=? AND status="processing"', [req.params.id]);
    if (!wr) return res.status(404).json({ error: 'Not found or not in processing state.' });

    await query(
      `UPDATE withdrawal_requests SET status='completed', completed_at=NOW() WHERE id=?`,
      [wr.id]
    );
    await query(
      `INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, 'success')`,
      [uuidv4(), wr.user_id,
       'Withdrawal Completed ✓',
       `Your withdrawal of $${parseFloat(wr.amount).toLocaleString()} has been sent to your bank account.`]
    );
    res.json({ message: 'Withdrawal marked as completed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark complete.' });
  }
}

// POST /api/withdrawals/admin/reject/:id  — refund the balance
async function adminReject(req, res) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[wr]] = await conn.execute(
      'SELECT * FROM withdrawal_requests WHERE id=? AND status="pending"',
      [req.params.id]
    );
    if (!wr) { await conn.rollback(); return res.status(404).json({ error: 'Not found or already processed.' }); }

    // Refund
    await conn.execute(
      'UPDATE users SET cash_balance=cash_balance+? WHERE id=?',
      [wr.amount, wr.user_id]
    );

    await conn.execute(
      `UPDATE withdrawal_requests SET status='rejected', admin_note=?, reviewed_by=?, reviewed_at=NOW() WHERE id=?`,
      [req.body.admin_note || 'Rejected', req.user.id, wr.id]
    );

    const [[user]] = await conn.execute('SELECT cash_balance FROM users WHERE id=?', [wr.user_id]);

    await conn.execute(
      `INSERT INTO transactions (id, user_id, type, amount, balance_after, reference_id, description, status)
       VALUES (?, ?, 'adjustment', ?, ?, ?, 'Withdrawal rejected — funds returned', 'completed')`,
      [uuidv4(), wr.user_id, wr.amount, user.cash_balance, wr.id]
    );

    await conn.execute(
      `INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, 'error')`,
      [uuidv4(), wr.user_id,
       'Withdrawal Rejected',
       `Your withdrawal of $${parseFloat(wr.amount).toLocaleString()} was rejected. Funds have been returned to your balance. Reason: ${req.body.admin_note || 'Contact support'}`]
    );

    await conn.commit();
    res.json({ message: 'Withdrawal rejected and balance refunded.' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Rejection failed.' });
  } finally {
    conn.release();
  }
}

module.exports = { createRequest, myRequests, adminGetAll, adminApprove, adminComplete, adminReject };
