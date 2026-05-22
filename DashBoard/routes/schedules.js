// Per-employee shift schedule. One row per employee.
// Bulk-edit screen: every active employee shown with inline form fields.

const express = require('express');
const { query, t } = require('../db');
const { requireAdmin } = require('../services/auth');

const router = express.Router();
router.use(requireAdmin);

// LIST + BULK EDIT
router.get('/', async (req, res, next) => {
    try {
        const rows = await query(
            `SELECT e.empfullname, e.displayname,
                    s.shift_start, s.shift_end, s.workdays, s.grace_minutes, s.active
             FROM ${t('employees')} e
             LEFT JOIN ${t('schedules')} s ON s.empfullname = e.empfullname
             WHERE e.disabled = 0
             ORDER BY e.displayname, e.empfullname`,
            []
        );
        const normalized = rows.map(r => ({
            empfullname: r.empfullname,
            displayname: r.displayname || r.empfullname,
            shift_start: r.shift_start || '',
            shift_end: r.shift_end || '',
            workdays: r.workdays || '1111100',
            grace_minutes: r.grace_minutes == null ? 10 : r.grace_minutes,
            active: r.active == null ? 1 : Number(r.active),
            hasSchedule: r.shift_start != null,
        }));
        res.render('schedules', { title: 'Schedules', rows: normalized });
    } catch (err) { next(err); }
});

// BULK SAVE
router.post('/', async (req, res, next) => {
    // Form sends parallel arrays keyed by emp[]/start[]/etc. We zip them up.
    const emps = [].concat(req.body.emp || []);
    const starts = [].concat(req.body.shift_start || []);
    const ends = [].concat(req.body.shift_end || []);
    const graces = [].concat(req.body.grace_minutes || []);
    const actives = req.body.active_map || {};
    const dayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

    try {
        for (let i = 0; i < emps.length; i++) {
            const emp = emps[i];
            const start = (starts[i] || '').trim();
            const end = (ends[i] || '').trim();
            const grace = parseInt(graces[i], 10);
            const active = actives && actives[emp] ? 1 : 0;

            // Days bitmask from checkboxes (named "day_<emp>_<dow>")
            let mask = '';
            for (const dk of dayKeys) {
                const k = `day_${emp}_${dk}`;
                mask += (req.body[k] ? '1' : '0');
            }

            if (!start || !end) {
                // No shift set — delete any existing row so it doesn't trigger alerts.
                await query(
                    `DELETE FROM ${t('schedules')} WHERE empfullname = ?`,
                    [emp]
                );
                continue;
            }

            await query(
                `INSERT INTO ${t('schedules')}
                 (empfullname, shift_start, shift_end, workdays, grace_minutes, active)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    shift_start = VALUES(shift_start),
                    shift_end = VALUES(shift_end),
                    workdays = VALUES(workdays),
                    grace_minutes = VALUES(grace_minutes),
                    active = VALUES(active)`,
                [
                    emp,
                    start,
                    end,
                    mask,
                    Number.isFinite(grace) ? grace : 10,
                    active,
                ]
            );
        }
        req.flash('success', 'Schedules saved.');
        res.redirect('/schedules');
    } catch (err) { next(err); }
});

module.exports = router;
