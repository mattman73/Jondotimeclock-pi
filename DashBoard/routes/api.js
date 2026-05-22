// Pi-facing JSON API. All routes here are bearer-token auth'd.
//
//   GET  /api/faces/photos                 list every reference photo
//                                          (id, empfullname, captured_at)
//   GET  /api/faces/photos/:id             stream the raw photo bytes
//   POST /api/punch                        trigger a clock-in/out by
//                                          empfullname (face-recognised)
//   POST /api/face-events                  bulk-insert audit log rows
//   GET  /api/scanner-state                is the scanner scheduled on?
//
// The Pi pulls /api/faces/photos every few minutes, downloads any
// it doesn't have locally, and rebuilds embeddings on disk. When
// it makes a confident match it POSTs /api/punch with the
// employee's empfullname and the confidence score.

const express = require('express');
const { query, t } = require('../db');
const { bearer } = require('../services/apiAuth');
const { findByUsername } = require('../services/clockin');
const { punchByBadge } = require('../services/clockin');
const { computeCameraState } = require('../services/cameraSchedule');

const router = express.Router();
router.use(express.json({ limit: '256kb' }));
router.use(bearer);

// List of (active, opted-in) photos the Pi should sync.
router.get('/faces/photos', async (req, res, next) => {
    try {
        const rows = await query(
            `SELECT f.id, f.empfullname, f.captured_at, f.image_mime,
                    e.displayname
             FROM ${t('face_enrollments')} f
             JOIN ${t('employees')} e ON e.empfullname = f.empfullname
             WHERE f.deleted_at IS NULL
               AND e.disabled = 0
               AND e.face_opt_in = 1
             ORDER BY f.empfullname, f.id`,
            []
        );
        res.json({ ok: true, photos: rows });
    } catch (err) { next(err); }
});

// Raw bytes for a single photo (used by the Pi to download new ones).
router.get('/faces/photos/:id', async (req, res, next) => {
    try {
        const rows = await query(
            `SELECT f.image_blob, f.image_mime
             FROM ${t('face_enrollments')} f
             JOIN ${t('employees')} e ON e.empfullname = f.empfullname
             WHERE f.id = ?
               AND f.deleted_at IS NULL
               AND e.disabled = 0
               AND e.face_opt_in = 1`,
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ ok: false, error: 'not found or not opted in' });
        res.setHeader('Content-Type', rows[0].image_mime || 'image/jpeg');
        res.end(rows[0].image_blob);
    } catch (err) { next(err); }
});

// Trigger a punch (in/out toggle) by empfullname. Requires the
// matched employee to still exist + be active + be opted in.
router.post('/punch', async (req, res, next) => {
    try {
        const empfullname = (req.body.empfullname || '').trim();
        const confidence = Number(req.body.confidence);
        const piHost = (req.body.pi_host || '').toString().slice(0, 80);
        if (!empfullname) {
            return res.status(400).json({ ok: false, error: 'empfullname required' });
        }
        const emp = await findByUsername(empfullname);
        if (!emp) return res.status(404).json({ ok: false, error: 'unknown employee' });
        if (Number(emp.disabled) === 1) return res.status(403).json({ ok: false, error: 'disabled' });

        // Trigger a punch using the badge (so legacy info row matches
        // exactly what a barcode scan would produce). If the employee
        // has no badge, fall back to a synthetic call.
        // NB: employees_BadgeID can come back as a number from MySQL,
        // so coerce to string before trimming.
        const badge = String(emp.employees_BadgeID == null ? '' : emp.employees_BadgeID).trim();
        let action;
        if (badge) {
            const r = await punchByBadge(badge, { notes: 'face match', ip: piHost });
            if (!r.ok) return res.status(500).json({ ok: false, error: r.reason });
            action = r.action;
        } else {
            // No badge — simulate the toggle directly.
            const newAction = (emp.employees_inout === 'in') ? 'out' : 'in';
            const ts = Math.floor(Date.now() / 1000);
            await query(
                `INSERT INTO ${t('info')}
                    (fullname, BadgeID, \`inout\`, timestamp, notes, ipaddress)
                 VALUES (?, '', ?, ?, 'face match', ?)`,
                [empfullname, newAction, ts, piHost]
            );
            await query(
                `UPDATE ${t('employees')}
                 SET tstamp = ?, employees_inout = ? WHERE empfullname = ?`,
                [ts, newAction, empfullname]
            );
            action = newAction;
        }

        // Audit row alongside the punch
        await query(
            `INSERT INTO ${t('face_audit')}
                (empfullname, confidence, action, reason, pi_host)
             VALUES (?, ?, 'matched', ?, ?)`,
            [empfullname, isFinite(confidence) ? confidence : null, 'punched ' + action, piHost]
        );

        res.json({
            ok: true,
            empfullname,
            displayname: emp.displayname || empfullname,
            action,
        });
    } catch (err) { next(err); }
});

// The Pi can post diagnostic events here in batches (no_face, rejected etc.)
router.post('/face-events', async (req, res, next) => {
    try {
        const events = Array.isArray(req.body.events) ? req.body.events : [];
        const piHost = (req.body.pi_host || '').toString().slice(0, 80);
        if (!events.length) return res.json({ ok: true, inserted: 0 });
        let inserted = 0;
        for (const e of events) {
            await query(
                `INSERT INTO ${t('face_audit')}
                    (empfullname, confidence, action, reason, pi_host)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    e.empfullname || null,
                    isFinite(Number(e.confidence)) ? Number(e.confidence) : null,
                    String(e.action || 'unknown').slice(0, 30),
                    String(e.reason || '').slice(0, 120),
                    piHost,
                ]
            );
            inserted++;
        }
        res.json({ ok: true, inserted });
    } catch (err) { next(err); }
});

// The Pi polls this to learn whether it should be running face
// recognition right now. The camera follows a schedule set in the
// dashboard (Settings -> Camera schedule); outside its hours the
// Pi pauses matching. If the schedule columns aren't migrated yet,
// or the row is missing, this returns active = true (always on).
router.get('/scanner-state', async (req, res, next) => {
    try {
        let row = {};
        try {
            const rows = await query(
                `SELECT camera_schedule_enabled, camera_morning_on, camera_morning_off,
                        camera_evening_on, camera_evening_off,
                        camera_wake_minutes, camera_wake_until
                 FROM ${t('alert_settings')} WHERE id = 1`,
                []
            );
            row = rows[0] || {};
        } catch (e) {
            // columns not migrated — fall through to always-on default
        }
        const state = computeCameraState(row);
        res.json({ ok: true, active: state.active, reason: state.reason });
    } catch (err) { next(err); }
});

module.exports = router;
