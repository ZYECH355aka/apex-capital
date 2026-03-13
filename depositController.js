// controllers/depositController.js
const { v4: uuidv4 } = require('uuid');
const { query, getPool } = require('../config/database');

// GET /api/deposits/bank-details  — bank info shown to users for transfer
async function getBankDetails(req, res) {
  res.json({
    bank_name:      process.env.BANK_NAME,
    account_name:   process.env.BANK_ACCOUNT_NAME,
    account_number: process.env.BANK_ACCOUNT_NUMBER,
    routing_number: process.env.BANK_ROUTING_NUMBER,
    swift_code:     process.env.BANK_SWIFT,
    instructions: [
      'Transfer the exact amount to the bank account above.',
      `Use reference: ${process.env.BANK_REFERENCE_PREFIX}-${req.user.id.slice(-6).toUpperCase()}`,
      'Upload proof of payment (screenshot or PDF).',
      'Your balance will be credited within 1–24 hours after admin approval.',
    ]
  });
}

// POST /api/deposits/request — user submits deposit request
async function createRequest(req, res) {
  try {
    const { amount, reference, sender_name, sender_bank, notes } = req.body;
    const proof_file = req.file ? req.file.path : null;

    if (!amount || isNaN(amount) || parseFloat(amount) < 100)
      return res.status(400).json({ error: 'Minimum deposit amount is $100.' });
    if (!reference || !sender_name || !sender_bank)
      return res.status(400).json({ error: 'Reference, sender name, and bank are required.' });

    // Check for duplicate reference
    const dup = await query('SELECT id FROM deposit_requests WHERE reference=?', [reference]);
    if (dup.length) return res.status(409).json({ error: 'This transfer reference has already been submitted.' });

    const id = uuidv4();
    await query(
      `INSERT INTO deposit_requests (id, user_id, amount, reference, sender_name, sender_bank, proof_file, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, parseFloat(amount), reference, sender_name, sender_bank, proof_file, notes || null]
    );

    // Notify admin (log / future email)
    console.log(`📩 New deposit request #${id} from ${req.user.email} — $${amount}`);

    res.status(201).json({
      message: 'Deposit request submitted. Pending admin approval.',
      request_id: id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit deposit request.' });
  }
}

// GET /api/deposits/my — user's own requests
async function myRequests(req, res) {
  try {
    const rows = await query(
      `SELECT id, amount, reference, sender_name, sender_bank, status, admin_note, created_at, reviewed_at
       FROM deposit_requests WHERE user_id=? ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch deposit requests.' });
  }
}

// ── ADMIN ROUTES ────────────────────────────────────────────────

// GET /api/deposits/admin/all
async function adminGetAll(req, res) {
  try {
    const { status } = req.query;
    let sql = `
      SELECT dr.*, u.email, u.first_name, u.last_name
      FROM deposit_requests dr
      JOIN users u ON dr.user_id = u.id
    `;
    const params = [];
    if (status) { sql += ' WHERE dr.status=?'; params.push(status); }
    sql += ' ORDER BY dr.created_at DESC';
    const rows = await query(sql, params);
    res.json({ requests: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests.' });
  }
}

// POST /api/deposits/admin/approve/:id
async function adminApprove(req, res) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [deposit] = await conn.execute(
      'SELECT * FROM deposit_requests WHERE id=? AND status="pending"',
      [req.params.id]
    );
    if (!deposit.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Request not found or already processed.' });
    }
    const dep = deposit[0];

    // Mark approved
    await conn.execute(
      `UPDATE deposit_requests SET status='approved', admin_note=?, reviewed_by=?, reviewed_at=NOW()
       WHERE id=?`,
      [req.body.admin_note || null, req.user.id, dep.id]
    );

    // Credit user balance
    await conn.execute(
      `UPDATE users SET
         cash_balance     = cash_balance + ?,
         total_deposited  = total_deposited + ?
       WHERE id=?`,
      [dep.amount, dep.amount, dep.user_id]
    );

    // Fetch new balance
    const [[user]] = await conn.execute('SELECT cash_balance FROM users WHERE id=?', [dep.user_id]);

    // Ledger entry
    await conn.execute(
      `INSERT INTO transactions (id, user_id, type, amount, balance_after, reference_id, description, status)
       VALUES (?, ?, 'deposit', ?, ?, ?, ?, 'completed')`,
      [uuidv4(), dep.user_id, dep.amount, user.cash_balance,
       dep.id, `Deposit approved — Ref: ${dep.reference}`]
    );

    // Notify user
    await conn.execute(
      `INSERT INTO notifications (id, user_id, title, message, type)
       VALUES (?, ?, ?, ?, 'success')`,
      [uuidv4(), dep.user_id,
       'Deposit Approved ✓',
       `Your deposit of $${dep.amount.toLocaleString()} has been approved and credited to your account.`]
    );

    await conn.commit();
    res.json({ message: `Deposit of $${dep.amount} approved and credited.` });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Approval failed.' });
  } finally {
    conn.release();
  }
}

// POST /api/deposits/admin/reject/:id
async function adminReject(req, res) {
  try {
    const [dep] = await query(
      'SELECT * FROM deposit_requests WHERE id=? AND status="pending"',
      [req.params.id]
    );
    if (!dep) return res.status(404).json({ error: 'Request not found or already processed.' });

    await query(
      `UPDATE deposit_requests SET status='rejected', admin_note=?, reviewed_by=?, reviewed_at=NOW()
       WHERE id=?`,
      [req.body.admin_note || 'Rejected by admin', req.user.id, req.params.id]
    );

    await query(
      `INSERT INTO notifications (id, user_id, title, message, type)
       VALUES (?, ?, ?, ?, 'error')`,
      [uuidv4(), dep.user_id,
       'Deposit Rejected',
       `Your deposit request of $${dep.amount} was rejected. Reason: ${req.body.admin_note || 'Contact support'}`]
    );

    res.json({ message: 'Deposit request rejected.' });
  } catch (err) {
    res.status(500).json({ error: 'Rejection failed.' });
  }
}

module.exports = { getBankDetails, createRequest, myRequests, adminGetAll, adminApprove, adminReject };
