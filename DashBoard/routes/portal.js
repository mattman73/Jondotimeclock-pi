// Staff portal — landing page for non-admin employees after sign-in.
//   GET /portal           dashboard with quick actions + summary
//
// Admins won't normally see this (they get redirected to /dashboard
// after login), but if they navigate here directly we still show it.

const express = require('express');
const { query, t } = require('../db');
const { requireLogin } = require('../services/auth');
const { computeRemainingAllowance } = require('../services/timeoff');

const router = express.Router();
router.use(requireLogin);

router.get('/', async (req, res, next) => {
    try {
        const me = req.session.user.empfullname;
        const allowance = await computeRemainingAllowance(me);

        // Pending requests count
        const pending = await query(
            `SELECT COUNT(*) AS c FROM ${t('time_off_requests')}
             WHERE empfullname = ? AND status = 'pending'`,
            [me]
        );
        // Most recent few requests
        const recent = await query(
            `SELECT id, request_type, start_datetime, end_datetime,
                    hours_requested, status, submitted_at
             FROM ${t('time_off_requests')}
             WHERE empfullname = ?
             ORDER BY submitted_at DESC
             LIMIT 5`,
            [me]
        );

        res.render('portal', {
            title: 'My portal',
            me: req.session.user,
            allowance,
            pendingCount: pending[0] ? pending[0].c : 0,
            recent,
        });
    } catch (err) { next(err); }
});

module.exports = router;
