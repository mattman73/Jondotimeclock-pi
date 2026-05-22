// Punch (clock-in/out) logic. Mirrors the behaviour of the legacy
// Clockinout.php so the new Node kiosk and the old PHP page write
// data the same way.
//
// Key contract:
//   - Look up an employee by employees_BadgeID (the barcode value
//     scanned at the kiosk).
//   - The employee's CURRENT state lives in employees.employees_inout.
//     If that's "in", we punch them OUT. Otherwise (out / blank /
//     null) we punch them IN. There is no choice presented to the
//     user — it's a strict toggle.
//   - We INSERT a row in `info` (the audit log of every punch),
//     UPDATE the employees row with the new state and timestamp.
//
// Returned object lets the route render a confirmation:
//   { ok: true,  empfullname, displayname, action: 'in'|'out' }
//   { ok: false, reason: 'unknown badge' | 'employee disabled' }

const { query, t } = require('../db');
const { verifyPassword } = require('./auth');

async function findByBadge(badgeId) {
    if (!badgeId) return null;
    const rows = await query(
        `SELECT empfullname, displayname, email,
                employees_BadgeID, employees_inout, disabled
         FROM ${t('employees')}
         WHERE employees_BadgeID = ?
         LIMIT 1`,
        [String(badgeId).trim()]
    );
    return rows[0] || null;
}

async function findByUsername(username) {
    if (!username) return null;
    const rows = await query(
        `SELECT empfullname, displayname, email, employee_passwd,
                employees_BadgeID, employees_inout, disabled
         FROM ${t('employees')}
         WHERE empfullname = ?
         LIMIT 1`,
        [String(username).trim()]
    );
    return rows[0] || null;
}

// Insert one info row + flip employees_inout/tstamp. Returns the
// resolved action ('in' or 'out').
async function recordPunch(emp, { notes = '', ip = '' } = {}) {
    const action = (emp.employees_inout === 'in') ? 'out' : 'in';
    const ts = Math.floor(Date.now() / 1000);

    await query(
        `INSERT INTO ${t('info')}
            (fullname, BadgeID, \`inout\`, timestamp, notes, ipaddress)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [emp.empfullname, emp.employees_BadgeID || '', action, ts, notes || '', ip || '']
    );

    await query(
        `UPDATE ${t('employees')}
         SET tstamp = ?, employees_inout = ?
         WHERE empfullname = ?`,
        [ts, action, emp.empfullname]
    );

    return { action, ts };
}

// Public entry: badge-driven punch.
async function punchByBadge(badgeId, opts = {}) {
    const emp = await findByBadge(badgeId);
    if (!emp) return { ok: false, reason: 'unknown badge' };
    if (Number(emp.disabled) === 1) return { ok: false, reason: 'employee disabled' };
    const { action, ts } = await recordPunch(emp, opts);
    return {
        ok: true,
        empfullname: emp.empfullname,
        displayname: emp.displayname || emp.empfullname,
        action,
        ts,
    };
}

// Public entry: password-driven punch (for staff without a badge).
async function punchByPassword(username, password, opts = {}) {
    const emp = await findByUsername(username);
    if (!emp) return { ok: false, reason: 'unknown user' };
    if (Number(emp.disabled) === 1) return { ok: false, reason: 'employee disabled' };
    if (!verifyPassword(password, emp.employee_passwd)) {
        return { ok: false, reason: 'wrong password' };
    }
    const { action, ts } = await recordPunch(emp, opts);
    return {
        ok: true,
        empfullname: emp.empfullname,
        displayname: emp.displayname || emp.empfullname,
        action,
        ts,
    };
}

module.exports = { punchByBadge, punchByPassword, findByBadge, findByUsername };
