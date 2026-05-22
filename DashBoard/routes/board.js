// Public "who's in / out" wall display. No login required.
//   GET /board

const express = require('express');
const { query, t } = require('../db');
const { formatStamp } = require('../services/timeUtils');

const router = express.Router();

router.get('/', async (req, res, next) => {
    try {
        const rows = await query(
            `SELECT empfullname, displayname, employees_inout, tstamp
             FROM ${t('employees')}
             WHERE disabled = 0
             ORDER BY (employees_inout = 'in') DESC, displayname, empfullname`,
            []
        );
        const formatted = rows.map(r => ({
            empfullname: r.empfullname,
            displayname: r.displayname || r.empfullname,
            state: (r.employees_inout || '').toLowerCase() === 'in' ? 'in' : 'out',
            since: r.tstamp ? formatStamp(r.tstamp) : '',
        }));
        const counts = {
            total: formatted.length,
            in: formatted.filter(r => r.state === 'in').length,
            out: formatted.filter(r => r.state === 'out').length,
        };
        res.render('board', { title: "Who's in", rows: formatted, counts });
    } catch (err) { next(err); }
});

module.exports = router;
