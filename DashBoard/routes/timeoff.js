// Time-off request routes.
//
// Staff (any logged-in employee):
//   GET  /timeoff           redirect to /timeoff/new
//   GET  /timeoff/new       request form
//   POST /timeoff/new       submit a request
//   GET  /timeoff/mine      my own requests + allowance summary
//   POST /timeoff/:id/cancel    cancel a request
//
// Admin only:
//   GET  /timeoff/admin     pending queue + history
//   GET  /timeoff/calendar  month calendar of approved leave
//   POST /timeoff/:id/approve
//   POST /timeoff/:id/reject

const express = require('express');
const { query, t } = require('../db');
const { requireLogin, requireAdmin } = require('../services/auth');
const { sendMail } = require('./../services/mailer');
const { sendWhatsApp } = require('./../services/whatsapp');
const {
    REQUEST_TYPES,
    isValidType,
    loadSettings,
    loadNonWorkingDays,
    parseLocalDateTime,
    formatMysqlDateTime,
    computeHours,
    computeRemainingAllowance,
    validateRequest,
} = require('../services/timeoff');

const router = express.Router();
router.use(requireLogin);

function isAdmin(req) {
    const u = req.session && req.session.user;
    return u && (Number(u.admin) || Number(u.time_admin));
}

// /timeoff -> /timeoff/new for staff, /timeoff/admin for admins
router.get('/', (req, res) => {
    if (isAdmin(req)) return res.redirect('/timeoff/admin');
    res.redirect('/timeoff/new');
});

// ---------- new request form ----------
router.get('/new', async (req, res, next) => {
    try {
        const me = req.session.user.empfullname;
        const allowance = await computeRemainingAllowance(me);
        res.render('timeoff/new', {
            title: 'Book time off',
            me: req.session.user,
            types: REQUEST_TYPES,
            allowance,
            form: { request_type: 'holiday', start_datetime: '', end_datetime: '', reason: '' },
        });
    } catch (err) { next(err); }
});

router.post('/new', async (req, res, next) => {
    try {
        const me = req.session.user.empfullname;
        const settings = await loadSettings();
        const type = (req.body.request_type || '').toLowerCase();
        const startStr = req.body.start_datetime || '';
        const endStr = req.body.end_datetime || '';
        const reason = (req.body.reason || '').trim().slice(0, 500);

        const startDate = parseLocalDateTime(startStr);
        const endDate = parseLocalDateTime(endStr);

        const validation = await validateRequest(me, type, startDate, endDate, settings);
        if (!validation.ok) {
            req.flash('error', validation.reason);
            return res.redirect('/timeoff/new');
        }

        const skip = await loadNonWorkingDays(startDate, endDate);
        const hours = computeHours(startDate, endDate, settings.standard_workday_hours, skip);
        await query(
            `INSERT INTO ${t('time_off_requests')}
                (empfullname, request_type, start_datetime, end_datetime,
                 hours_requested, reason, status)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
            [
                me,
                type,
                formatMysqlDateTime(startDate),
                formatMysqlDateTime(endDate),
                hours,
                reason,
            ]
        );

        // Email the admin
        const notify = settings.timeoff_notify_email || settings.manager_email;
        if (notify) {
            const display = req.session.user.displayname || me;
            const port = process.env.PORT || 3000;
            sendMail({
                to: notify,
                subject: `[Jondo] Time-off request from ${display} (${type})`,
                text:
`${display} (${me}) has submitted a time-off request:

  Type:    ${type}
  From:    ${startDate.toLocaleString()}
  To:      ${endDate.toLocaleString()}
  Hours:   ${hours.toFixed(2)}
  Reason:  ${reason || '(none given)'}

Review it: http://localhost:${port}/timeoff/admin`,
            }).catch(e => console.error('[timeoff] notify mail:', e.message));
        }

        // WhatsApp the managers as well (separate channel from email;
        // self-gated by the whatsapp_enabled setting).
        {
            const display = req.session.user.displayname || me;
            const waText =
                `New time-off request: ${display} (${type}), ${hours.toFixed(2)}h, `
                + `${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}. `
                + `Review it on the dashboard.`;
            // No settings arg — sendWhatsApp loads the full
            // alert_settings row itself (this route's `settings` is a
            // trimmed projection without the whatsapp_* columns).
            sendWhatsApp(waText)
                .catch(e => console.error('[timeoff] whatsapp:', e.message));
        }

        req.flash('success', `Request submitted (${hours.toFixed(1)} hours). You'll be emailed when it's reviewed.`);
        res.redirect('/timeoff/mine');
    } catch (err) { next(err); }
});

// ---------- my requests ----------
router.get('/mine', async (req, res, next) => {
    try {
        const me = req.session.user.empfullname;
        const allowance = await computeRemainingAllowance(me);
        const requests = await query(
            `SELECT id, request_type, start_datetime, end_datetime,
                    hours_requested, reason, status, submitted_at,
                    reviewed_at, reviewed_by, review_note
             FROM ${t('time_off_requests')}
             WHERE empfullname = ?
             ORDER BY submitted_at DESC`,
            [me]
        );
        res.render('timeoff/mine', {
            title: 'My time-off requests',
            me: req.session.user,
            allowance,
            requests,
        });
    } catch (err) { next(err); }
});

// ---------- cancel a request ----------
// Staff may cancel their own PENDING request. Admins may also cancel
// an already-APPROVED request (plans changed, booked in error, etc.)
// — and the employee is emailed when an admin does so.
router.post('/:id/cancel', async (req, res, next) => {
    try {
        const me = req.session.user.empfullname;
        const admin = isAdmin(req);
        const rows = await query(
            `SELECT r.id, r.empfullname, r.request_type, r.status,
                    r.start_datetime, r.end_datetime, r.hours_requested,
                    e.email AS emp_email, e.displayname AS emp_displayname
             FROM ${t('time_off_requests')} r
             JOIN ${t('employees')} e ON e.empfullname = r.empfullname
             WHERE r.id = ?`,
            [req.params.id]
        );
        const backUrl = admin ? '/timeoff/admin' : '/timeoff/mine';
        if (!rows.length) {
            req.flash('error', 'Request not found.');
            return res.redirect(backUrl);
        }
        const r = rows[0];
        if (r.empfullname !== me && !admin) {
            req.flash('error', 'Not yours.');
            return res.redirect('/timeoff/mine');
        }
        // Non-admins: only their own pending request.
        // Admins: pending or already-approved.
        const allowed = admin ? ['pending', 'approved'] : ['pending'];
        if (!allowed.includes(r.status)) {
            req.flash('error', `Can't cancel a ${r.status} request.`);
            return res.redirect(backUrl);
        }
        const wasApproved = r.status === 'approved';

        await query(
            `UPDATE ${t('time_off_requests')}
             SET status = 'cancelled', reviewed_at = NOW(), reviewed_by = ?
             WHERE id = ?`,
            [me, req.params.id]
        );

        // When an admin cancels someone else's request, tell the
        // employee — especially important for approved leave they had
        // already planned around.
        if (admin && r.empfullname !== me && r.emp_email) {
            sendMail({
                to: r.emp_email,
                subject: `[Jondo] Your ${r.request_type} time off has been cancelled`,
                text:
`Hi ${r.emp_displayname || r.empfullname},

Your ${wasApproved ? 'approved ' : ''}${r.request_type} time off has been cancelled by a manager.

  From:  ${r.start_datetime}
  To:    ${r.end_datetime}
  Hours: ${Number(r.hours_requested).toFixed(2)}

If this is unexpected, please speak to your manager.`,
            }).catch(e => console.error('[timeoff] cancel mail:', e.message));
        }

        req.flash('success',
            wasApproved
                ? 'Approved time off cancelled — the employee has been emailed.'
                : 'Request cancelled.');
        res.redirect(backUrl);
    } catch (err) { next(err); }
});

// ---------- admin queue ----------
router.get('/admin', requireAdmin, async (req, res, next) => {
    try {
        const pending = await query(
            `SELECT r.id, r.empfullname, e.displayname, r.request_type,
                    r.start_datetime, r.end_datetime, r.hours_requested,
                    r.reason, r.submitted_at
             FROM ${t('time_off_requests')} r
             JOIN ${t('employees')} e ON e.empfullname = r.empfullname
             WHERE r.status = 'pending'
             ORDER BY r.start_datetime ASC`,
            []
        );
        const history = await query(
            `SELECT r.id, r.empfullname, e.displayname, r.request_type,
                    r.start_datetime, r.end_datetime, r.hours_requested,
                    r.reason, r.status, r.submitted_at, r.reviewed_at,
                    r.reviewed_by, r.review_note
             FROM ${t('time_off_requests')} r
             JOIN ${t('employees')} e ON e.empfullname = r.empfullname
             WHERE r.status <> 'pending'
             ORDER BY r.reviewed_at DESC
             LIMIT 50`,
            []
        );
        res.render('timeoff/admin', {
            title: 'Time-off requests',
            pending,
            history,
        });
    } catch (err) { next(err); }
});

// ---------- admin calendar ----------
router.get('/calendar', requireAdmin, async (req, res, next) => {
    try {
        const now = new Date();
        let year = parseInt(req.query.y, 10);
        let month = parseInt(req.query.m, 10); // 1-12
        if (!Number.isFinite(year) || year < 2000 || year > 2100) year = now.getFullYear();
        if (!Number.isFinite(month) || month < 1 || month > 12) month = now.getMonth() + 1;

        const monthStart = new Date(year, month - 1, 1);
        const monthEnd = new Date(year, month, 1);

        const fmt = (d) => formatMysqlDateTime(d);
        const approved = await query(
            `SELECT r.empfullname, e.displayname, r.request_type,
                    r.start_datetime, r.end_datetime
             FROM ${t('time_off_requests')} r
             JOIN ${t('employees')} e ON e.empfullname = r.empfullname
             WHERE r.status = 'approved'
               AND r.start_datetime < ?
               AND r.end_datetime   > ?
             ORDER BY r.start_datetime ASC`,
            [fmt(monthEnd), fmt(monthStart)]
        );
        const holidays = await query(
            `SELECT DATE_FORMAT(holiday_date, '%Y-%m-%d') AS d, label
             FROM ${t('non_working_days')}
             WHERE holiday_date >= DATE_FORMAT(?, '%Y-%m-%d')
               AND holiday_date <  DATE_FORMAT(?, '%Y-%m-%d')`,
            [fmt(monthStart), fmt(monthEnd)]
        );

        // Build day buckets for the view.
        function pad(n) { return n < 10 ? '0' + n : '' + n; }
        function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
        const daysInMonth = new Date(year, month, 0).getDate();
        const days = [];
        for (let i = 1; i <= daysInMonth; i++) {
            const d = new Date(year, month - 1, i);
            days.push({
                date: ymd(d),
                dow: d.getDay(),
                day: i,
                leave: [],
                holiday: null,
            });
        }
        for (const h of holidays) {
            const d = days.find(x => x.date === h.d);
            if (d) d.holiday = h.label || 'Holiday';
        }
        for (const r of approved) {
            const rs = new Date(r.start_datetime);
            const re = new Date(r.end_datetime);
            for (const d of days) {
                const dStart = new Date(year, month - 1, d.day, 0, 0, 0);
                const dEnd   = new Date(year, month - 1, d.day, 23, 59, 59);
                if (rs < dEnd && re > dStart) {
                    d.leave.push({
                        emp: r.displayname || r.empfullname,
                        type: r.request_type,
                    });
                }
            }
        }

        const prevMonth = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
        const nextMonth = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };

        res.render('timeoff/calendar', {
            title: 'Leave calendar',
            year, month,
            monthLabel: monthStart.toLocaleString('en-GB', { month: 'long', year: 'numeric' }),
            days,
            prevMonth, nextMonth,
            firstDow: new Date(year, month - 1, 1).getDay(),
        });
    } catch (err) { next(err); }
});

async function decide(id, newStatus, reviewer, note) {
    const rows = await query(
        `SELECT r.*, e.email AS emp_email, e.displayname AS emp_displayname
         FROM ${t('time_off_requests')} r
         JOIN ${t('employees')} e ON e.empfullname = r.empfullname
         WHERE r.id = ?`,
        [id]
    );
    if (!rows.length) return { ok: false, reason: 'not found' };
    const r = rows[0];
    if (r.status !== 'pending') return { ok: false, reason: `already ${r.status}` };

    await query(
        `UPDATE ${t('time_off_requests')}
         SET status = ?, reviewed_at = NOW(), reviewed_by = ?, review_note = ?
         WHERE id = ?`,
        [newStatus, reviewer, note, id]
    );

    if (r.emp_email) {
        const verb = newStatus === 'approved' ? 'approved' : 'declined';
        sendMail({
            to: r.emp_email,
            subject: `[Jondo] Your ${r.request_type} request has been ${verb}`,
            text:
`Hi ${r.emp_displayname || r.empfullname},

Your time-off request has been ${verb}.

  Type:    ${r.request_type}
  From:    ${r.start_datetime}
  To:      ${r.end_datetime}
  Hours:   ${Number(r.hours_requested).toFixed(2)}
${note ? '  Manager note: ' + note + '\n' : ''}
Sign in to view your requests.`,
        }).catch(e => console.error('[timeoff] decide mail:', e.message));
    }
    return { ok: true, row: r };
}

router.post('/:id/approve', requireAdmin, async (req, res, next) => {
    try {
        const reviewer = req.session.user.empfullname;
        const note = (req.body.review_note || '').trim().slice(0, 500);
        const result = await decide(req.params.id, 'approved', reviewer, note);
        if (!result.ok) req.flash('error', 'Could not approve: ' + result.reason);
        else req.flash('success', 'Approved.');
        res.redirect('/timeoff/admin');
    } catch (err) { next(err); }
});

router.post('/:id/reject', requireAdmin, async (req, res, next) => {
    try {
        const reviewer = req.session.user.empfullname;
        const note = (req.body.review_note || '').trim().slice(0, 500);
        const result = await decide(req.params.id, 'rejected', reviewer, note);
        if (!result.ok) req.flash('error', 'Could not reject: ' + result.reason);
        else req.flash('success', 'Rejected.');
        res.redirect('/timeoff/admin');
    } catch (err) { next(err); }
});

module.exports = router;
