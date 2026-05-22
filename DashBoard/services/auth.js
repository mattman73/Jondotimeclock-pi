// Auth helpers — built around the legacy phpTimeclock password format
// so the same accounts work in both the PHP app and this dashboard.
//
// PHP did: crypt($plain, 'xy')
// That is DES-based crypt(3) with the two-character salt "xy". The
// resulting hash is also 13 chars and starts with "xy". We reproduce it
// here using `unix-crypt-td-js` (a pure-JS port of the libc routine)
// so we can both VERIFY existing hashes and CREATE new ones the PHP
// side can read back.

const unixCrypt = require('unix-crypt-td-js');
const { query, t } = require('../db');

const SALT = 'xy';

function hashPassword(plain) {
    return unixCrypt(plain, SALT);
}

function verifyPassword(plain, stored) {
    if (!stored) return false;
    return unixCrypt(plain, SALT) === stored;
}

// Returns the employee row if credentials are valid and the account is
// active. ANY active employee can authenticate — regular staff land
// on /portal (time-off, profile etc), admins on /dashboard.
// The admin-only pages still require admin/time_admin via requireAdmin.
async function authenticate(username, password) {
    const rows = await query(
        `SELECT empfullname, displayname, email, employee_passwd,
                admin, reports, time_admin, disabled
         FROM ${t('employees')}
         WHERE empfullname = ?`,
        [username]
    );
    if (!rows.length) return null;
    const emp = rows[0];
    if (Number(emp.disabled) === 1) return null;
    if (!verifyPassword(password, emp.employee_passwd)) return null;
    return emp;
}

// Convenience: where to send a user after login.
function postLoginRedirect(user) {
    if (Number(user.admin) || Number(user.time_admin) || Number(user.reports)) {
        return '/dashboard';
    }
    return '/portal';
}

function requireLogin(req, res, next) {
    if (!req.session || !req.session.user) {
        if (req.method === 'GET') {
            return res.redirect('/login');
        }
        return res.status(401).json({ error: 'login required' });
    }
    return next();
}

function requireAdmin(req, res, next) {
    const u = req.session && req.session.user;
    if (!u || !(Number(u.admin) || Number(u.time_admin))) {
        req.flash('error', 'Admin access required.');
        return res.redirect('/dashboard');
    }
    return next();
}

module.exports = {
    hashPassword,
    verifyPassword,
    authenticate,
    postLoginRedirect,
    requireLogin,
    requireAdmin,
};
