// Fire / evacuation roll-call. The page shows everyone currently
// "in" (not yet clocked out) according to employees_inout. The
// manager taps each name as they confirm the person at the
// assembly point. State is persisted in fire_accounted so a server
// restart mid-drill doesn't lose progress.
//
// Routes:
//   GET  /fire             roll-call view
//   POST /fire/account     mark a single person accounted-for
//   POST /fire/unaccount   undo
//   POST /fire/end         end drill, clear all state

const express = require('express');
const { query, t } = require('../db');
const { requireLogin } = require('../services/auth');

const router = express.Router();

// Roll-call is sensitive (lists who is in the building) — require login.
router.use(requireLogin);

router.get('/', async (req, res, next) => {
    try {
        const employees = await query(
            `SELECT empfullname, displayname, employees_inout, tstamp
             FROM ${t('employees')}
             WHERE disabled = 0 AND employees_inout = 'in'
             ORDER BY displayname, empfullname`,
            []
        );
        const accounted = await query(
            `SELECT empfullname, accounted_at, accounted_by FROM ${t('fire_accounted')}`,
            []
        );
        const accSet = new Map(accounted.map(a => [a.empfullname, a]));

        const rows = employees.map(e => ({
            empfullname: e.empfullname,
            displayname: e.displayname || e.empfullname,
            accounted: accSet.has(e.empfullname),
            by: accSet.get(e.empfullname)?.accounted_by || '',
        }));

        const counts = {
            inBuilding: rows.length,
            accounted: rows.filter(r => r.accounted).length,
            outstanding: rows.filter(r => !r.accounted).length,
        };

        // Sort: outstanding first, then accounted (so the urgent ones
        // are at the top of the list).
        rows.sort((a, b) => {
            if (a.accounted !== b.accounted) return a.accounted ? 1 : -1;
            return a.displayname.localeCompare(b.displayname);
        });

        res.render('fire', { title: 'Fire roll-call', rows, counts });
    } catch (err) { next(err); }
});

router.post('/account', async (req, res, next) => {
    try {
        const emp = (req.body.emp || '').trim();
        if (!emp) return res.redirect('/fire');
        const by = (req.session.user && req.session.user.empfullname) || '';
        await query(
            `INSERT INTO ${t('fire_accounted')} (empfullname, accounted_by)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE accounted_by = VALUES(accounted_by),
                                     accounted_at = CURRENT_TIMESTAMP`,
            [emp, by]
        );
        res.redirect('/fire');
    } catch (err) { next(err); }
});

router.post('/unaccount', async (req, res, next) => {
    try {
        const emp = (req.body.emp || '').trim();
        if (!emp) return res.redirect('/fire');
        await query(
            `DELETE FROM ${t('fire_accounted')} WHERE empfullname = ?`,
            [emp]
        );
        res.redirect('/fire');
    } catch (err) { next(err); }
});

router.post('/end', async (req, res, next) => {
    try {
        await query(`DELETE FROM ${t('fire_accounted')}`, []);
        req.flash('success', 'Drill ended; roll-call reset.');
        res.redirect('/fire');
    } catch (err) { next(err); }
});

module.exports = router;
