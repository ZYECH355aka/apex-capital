// controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/database');

function signToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

// POST /api/auth/register
async function register(req, res) {
  try {
    const { first_name, last_name, email, password, phone } = req.body;
    if (!first_name || !last_name || !email || !password)
      return res.status(400).json({ error: 'All fields required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const existing = await query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) return res.status(409).json({ error: 'Email already registered.' });

    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    await query(
      `INSERT INTO users (id, first_name, last_name, email, phone, password)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, first_name, last_name, email, phone || null, hash]
    );

    // Welcome notification
    await query(
      `INSERT INTO notifications (id, user_id, title, message, type)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), id, 'Welcome to Apex Capital', `Your account has been created successfully. To start investing, please make your first deposit.`, 'success']
    );

    const [user] = await query('SELECT id, first_name, last_name, email, role, cash_balance, invested_balance FROM users WHERE id = ?', [id]);
    res.status(201).json({ token: signToken(id), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed.' });
  }
}

// POST /api/auth/login
async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const [user] = await query('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact support.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials.' });

    const { password: _, ...safeUser } = user;
    res.json({ token: signToken(user.id), user: safeUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed.' });
  }
}

// GET /api/auth/me
async function me(req, res) {
  try {
    const [user] = await query(
      `SELECT id, first_name, last_name, email, phone, role, status,
              cash_balance, invested_balance, total_deposited, total_withdrawn, created_at
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
}

// PUT /api/auth/profile
async function updateProfile(req, res) {
  try {
    const { first_name, last_name, phone } = req.body;
    await query(
      'UPDATE users SET first_name=?, last_name=?, phone=? WHERE id=?',
      [first_name, last_name, phone, req.user.id]
    );
    res.json({ message: 'Profile updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Update failed.' });
  }
}

// PUT /api/auth/change-password
async function changePassword(req, res) {
  try {
    const { current_password, new_password } = req.body;
    const [user] = await query('SELECT password FROM users WHERE id=?', [req.user.id]);
    const match = await bcrypt.compare(current_password, user.password);
    if (!match) return res.status(400).json({ error: 'Current password incorrect.' });
    if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    const hash = await bcrypt.hash(new_password, 12);
    await query('UPDATE users SET password=? WHERE id=?', [hash, req.user.id]);
    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Password change failed.' });
  }
}

module.exports = { register, login, me, updateProfile, changePassword };
