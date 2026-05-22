// Public kiosk routes. No login needed.
//   GET  /                kiosk page (badge scan)
//   POST /scan            AJAX badge submit -> JSON (in-page result)
//   GET  /recent-punch    poll for the latest punch (face-rec etc.)
//   GET  /camera-state    poll for camera awake/asleep state
//   POST /camera-wake     wake the camera for a while (kiosk tap)
//   POST /                no-JS fallback badge submit -> result page
//   GET  /password        password-fallback form
//   POST /password        handle a password submit

const express = require('express');
const { punchByBadge, punchByPassword } = require('../services/clockin');
const { query } = require('../db');
const { computeCameraState } = require('../services/cameraSchedule');

const router = express.Router();

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket.remoteAddress || '';
}

// Kiosk settings (result-screen duration + camera stream URL),
// cached 30s so a busy kiosk isn't hitting the DB every request.
let cachedKiosk = { resultSecs: 5, cameraUrl: '', fetchedAt: 0 };
async function getKioskSettings() {
    const now = Date.now();
    if (now - cachedKiosk.fetchedAt < 30000) return cachedKiosk;
    try {
        const rows = await query(
            `SELECT kiosk_result_seconds, kiosk_camera_url
             FROM alert_settings WHERE id = 1`
        );
        if (rows[0]) {
            const v = Number(rows[0].kiosk_result_seconds);
            cachedKiosk = {
                resultSecs: (Number.isFinite(v) && v >= 1 && v <= 60) ? v : 5,
                cameraUrl: rows[0].kiosk_camera_url || '',
                fetchedAt: now,
            };
        }
    } catch (e) {
        // DB unreachable or columns not migrated yet — keep cached defaults.
    }
    return cachedKiosk;
}

// Camera awake/asleep state. Queried fresh (not cached) so a manual
// "wake" tap is reflected straight away. If the schedule columns
// aren't migrated yet, the camera is treated as always awake.
async function getCameraState() {
    try {
        const rows = await query(
            `SELECT camera_schedule_enabled, camera_morning_on, camera_morning_off,
                    camera_evening_on, camera_evening_off,
                    camera_wake_minutes, camera_wake_until
             FROM alert_settings WHERE id = 1`
        );
        return computeCameraState(rows[0] || {});
    } catch (e) {
        return { active: true, scheduleEnabled: false, reason: 'no-schedule' };
    }
}

router.get('/', async (req, res, next) => {
    try {
        const k = await getKioskSettings();
        const cam = await getCameraState();
        res.render('clock', {
            title: 'Clock In / Out',
            flash: null,
            isError: false,
            cameraUrl: k.cameraUrl,
            resultSecs: k.resultSecs,
            cameraActive: cam.active,
        });
    } catch (err) { next(err); }
});

// AJAX badge submit — returns JSON, no page navigation. The kiosk
// page shows an in-page result from this response.
router.post('/scan', async (req, res) => {
    try {
        const k = await getKioskSettings();
        const badge = (req.body.BadgeID || '').trim();
        const notes = (req.body.notes || '').trim().slice(0, 240);
        if (!badge) {
            return res.json({ ok: false, message: 'Please scan a badge.' });
        }
        const result = await punchByBadge(badge, { notes, ip: clientIp(req) });
        if (!result.ok) {
            return res.json({
                ok: false,
                message: result.reason === 'unknown badge'
                    ? 'Badge not recognised. Try again or use password sign-in.'
                    : 'This account is disabled. See your manager.',
            });
        }
        return res.json({
            ok: true,
            action: result.action,
            displayname: result.displayname,
            redirectSecs: k.resultSecs,
            tstamp: result.ts,
        });
    } catch (err) {
        console.error('[scan]', err);
        return res.json({ ok: false, message: 'Something went wrong. Please try again.' });
    }
});

// Lightweight poll endpoint. The kiosk page hits this every couple of
// seconds so a face-recognition punch from the Pi — which calls
// /api/punch on the server and never touches this browser — still
// shows an on-screen confirmation. Returns the single most recent
// punch across all employees, keyed by tstamp (epoch seconds).
router.get('/recent-punch', async (req, res) => {
    try {
        const rows = await query(
            `SELECT displayname, empfullname, employees_inout, tstamp
             FROM employees
             WHERE tstamp IS NOT NULL
             ORDER BY tstamp DESC
             LIMIT 1`
        );
        if (!rows.length || !rows[0].tstamp) {
            return res.json({ ok: true, tstamp: 0 });
        }
        const r = rows[0];
        return res.json({
            ok: true,
            tstamp: Number(r.tstamp),
            displayname: r.displayname || r.empfullname,
            action: r.employees_inout === 'in' ? 'in' : 'out',
        });
    } catch (e) {
        return res.json({ ok: false });
    }
});

// Poll endpoint for the kiosk: is the camera awake or asleep?
router.get('/camera-state', async (req, res) => {
    const st = await getCameraState();
    res.json({ ok: true, ...st });
});

// A staff member tapped the "sleeping" panel — wake the camera for
// camera_wake_minutes minutes by pushing camera_wake_until forward.
router.post('/camera-wake', async (req, res) => {
    try {
        const rows = await query(
            `SELECT camera_schedule_enabled, camera_morning_on, camera_morning_off,
                    camera_evening_on, camera_evening_off, camera_wake_minutes
             FROM alert_settings WHERE id = 1`
        );
        const row = rows[0] || {};
        let mins = Number(row.camera_wake_minutes);
        if (!Number.isFinite(mins) || mins < 1 || mins > 240) mins = 15;
        const wakeUntil = Math.floor(Date.now() / 1000) + mins * 60;
        await query(
            `UPDATE alert_settings SET camera_wake_until = ? WHERE id = 1`,
            [wakeUntil]
        );
        row.camera_wake_until = wakeUntil;
        return res.json({ ok: true, ...computeCameraState(row) });
    } catch (e) {
        return res.json({ ok: false });
    }
});

// No-JS fallback: plain form POST -> full result page.
router.post('/', async (req, res, next) => {
    try {
        const k = await getKioskSettings();
        const badge = (req.body.BadgeID || '').trim();
        const notes = (req.body.notes || '').trim().slice(0, 240);
        if (!badge) {
            return res.render('clock', {
                title: 'Clock In / Out',
                flash: 'Please scan a badge.',
                isError: true,
                cameraUrl: k.cameraUrl,
                resultSecs: k.resultSecs,
                cameraActive: true,
            });
        }
        const result = await punchByBadge(badge, { notes, ip: clientIp(req) });
        if (!result.ok) {
            return res.render('clock', {
                title: 'Clock In / Out',
                flash: result.reason === 'unknown badge'
                    ? 'Badge not recognised. Try again or use password sign-in.'
                    : 'This account is disabled. See your manager.',
                isError: true,
                cameraUrl: k.cameraUrl,
                resultSecs: k.resultSecs,
                cameraActive: true,
            });
        }
        return res.render('clock-result', {
            title: result.action === 'in' ? 'Clocked in' : 'Clocked out',
            displayname: result.displayname,
            action: result.action,
            redirectSecs: k.resultSecs,
        });
    } catch (err) { next(err); }
});

router.get('/password', (req, res) => {
    res.render('clock-password', { title: 'Sign in', flash: null });
});

router.post('/password', async (req, res, next) => {
    try {
        const k = await getKioskSettings();
        const username = (req.body.username || '').trim();
        const password = req.body.password || '';
        const notes = (req.body.notes || '').trim().slice(0, 240);
        if (!username || !password) {
            return res.render('clock-password', {
                title: 'Sign in',
                flash: 'Username and password are both required.',
            });
        }
        const result = await punchByPassword(username, password, { notes, ip: clientIp(req) });
        if (!result.ok) {
            return res.render('clock-password', {
                title: 'Sign in',
                flash: result.reason === 'employee disabled'
                    ? 'This account is disabled. See your manager.'
                    : 'Username or password not recognised.',
            });
        }
        return res.render('clock-result', {
            title: result.action === 'in' ? 'Clocked in' : 'Clocked out',
            displayname: result.displayname,
            action: result.action,
            redirectSecs: k.resultSecs,
        });
    } catch (err) { next(err); }
});

module.exports = router;
