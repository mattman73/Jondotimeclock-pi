// Company-wide non-working days admin.
//   GET  /holidays              list + add form
//   POST /holidays              add one
//   POST /holidays/bulk         bulk-add UK bank holidays for a year
//   POST /holidays/:date/delete delete one

const express = require('express');
const { query, t } = require('../db');
const { requireAdmin } = require('../services/auth');
const { ukBankHolidays } = require('../services/ukBankHolidays');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
    try {
        // Default to the current and next year's view.
        const today = new Date();
        const fromYear = today.getFullYear();
        const rows = await query(
            `SELECT holiday_date, label, created_at, created_by
             FROM ${t('non_working_days')}
             WHERE holiday_date >= ?
             ORDER BY holiday_date ASC`,
            [fromYear + '-01-01']
        );
        res.render('holidays/index', {
            title: 'Non-working days',
            rows,
            currentYear: fromYear,
            nextYear: fromYear + 1,
        });
    } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
    try {
        const date = (req.body.holiday_date || '').trim();
        const label = (req.body.label || '').trim().slice(0, 80);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            req.flash('error', 'Date must be in YYYY-MM-DD format.');
            return res.redirect('/holidays');
        }
        const by = (req.session.user && req.session.user.empfullname) || '';
        await query(
            `INSERT INTO ${t('non_working_days')} (holiday_date, label, created_by)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE label = VALUES(label)`,
            [date, label, by]
        );
        req.flash('success', `Added ${date}${label ? ' (' + label + ')' : ''}.`);
        res.redirect('/holidays');
    } catch (err) { next(err); }
});

router.post('/bulk', async (req, res, next) => {
    try {
        const year = parseInt(req.body.year, 10);
        if (!Number.isFinite(year) || year < 2000 || year > 2100) {
            req.flash('error', 'Invalid year.');
            return res.redirect('/holidays');
        }
        const by = (req.session.user && req.session.user.empfullname) || '';
        const hols = ukBankHolidays(year);
        let added = 0;
        for (const h of hols) {
            const r = await query(
                `INSERT INTO ${t('non_working_days')} (holiday_date, label, created_by)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE label = ${t('non_working_days')}.label`,
                [h.date, h.label, by]
            );
            if (r.affectedRows === 1) added += 1;
        }
        req.flash('success', `UK bank holidays for ${year}: ${added} added (existing rows left alone).`);
        res.redirect('/holidays');
    } catch (err) { next(err); }
});

router.post('/:date/delete', async (req, res, next) => {
    try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
            req.flash('error', 'Bad date.');
            return res.redirect('/holidays');
        }
        await query(
            `DELETE FROM ${t('non_working_days')} WHERE holiday_date = ?`,
            [req.params.date]
        );
        req.flash('success', `Removed ${req.params.date}.`);
        res.redirect('/holidays');
    } catch (err) { next(err); }
});

module.exports = router;
