// Kiosk holiday-booking flow.
//
// A lightweight, badge-driven front door to the time-off system:
//   GET  /book           identify page (badge, or username/password)
//   POST /book/start     check identity -> open the booking form
//   GET  /book/form      the day-range booking form
//   POST /book/submit    validate + record + notify managers
//   GET  /book/done      confirmation
//
// Once a request is built it goes through exactly the same
// validation, allowance/overlap/notice checks and manager
// notifications (email + WhatsApp) as the /timeoff portal.

const express = require('express');
const { query, t } = require('../db');
const { findByBadge, findByUsername } = require('../services/clockin');
const { verifyPassword } = require('../services/auth');
const { sendMail } = require('../services/mailer');
const { sendWhatsApp } = require('../services/whatsapp');
const {
    REQUEST_TYPES,
    loadSettings,
    loadNonWorkingDays,
    formatMysqlDateTime,
    computeHours,
    computeRemainingAllowance,
    validateRequest,
} = require('../services/timeoff');

const router = express.Router();

const DAY_START_HOUR = 9;                       // working day assumed 09:00
const BOOK_SESSION_MAX_MS = 15 * 60 * 1000;     // identity good for 15 min

// The employee identified earlier in this booking session, if the
// identification is still fresh.
function bookingEmp(req) {
    const b = req.session && req.session.bookEmp;
    if (!b || !b.empfullname) return null;
    if (Date.now() - (b.ts || 0) > BOOK_SESSION_MAX_MS) return null;
    return b;
}

// ---------- identify ----------
router.get('/', (req, res) => {
    const mode = req.query.mode === 'password' ? 'password' : 'badge';
    res.render('book/identify', { title: 'Book time off', flash: null, mode });
});

router.post('/start', async (req, res, next) => {
    try {
        const mode = req.body.mode === 'password' ? 'password' : 'badge';
        let emp = null;

        if (mode === 'badge') {
            const badge = String(req.body.BadgeID || '').trim();
            if (!badge) {
                return res.render('book/identify', {
                    title: 'Book time off', mode: 'badge',
                    flash: 'Please scan or type your badge number.',
                });
            }
            emp = await findByBadge(badge);
            if (!emp) {
                return res.render('book/identify', {
                    title: 'Book time off', mode: 'badge',
                    flash: 'Badge not recognised. Try again, or use your password.',
                });
            }
        } else {
            const username = String(req.body.username || '').trim();
            const password = req.body.password || '';
            emp = await findByUsername(username);
            if (!emp || !verifyPassword(password, emp.employee_passwd)) {
                return res.render('book/identify', {
                    title: 'Book time off', mode: 'password',
                    flash: 'Username or password not recognised.',
                });
            }
        }

        if (Number(emp.disabled) === 1) {
            return res.render('book/identify', {
                title: 'Book time off', mode,
                flash: 'This account is disabled. Please see your manager.',
            });
        }

        req.session.bookEmp = {
            empfullname: emp.empfullname,
            displayname: emp.displayname || emp.empfullname,
            ts: Date.now(),
        };
        res.redirect('/book/form');
    } catch (err) { next(err); }
});

// ---------- booking form ----------
router.get('/form', async (req, res, next) => {
    try {
        const b = bookingEmp(req);
        if (!b) {
            return res.render('book/identify', {
                title: 'Book time off', mode: 'badge',
                flash: 'Please identify yourself to start.',
            });
        }
        const allowance = await computeRemainingAllowance(b.empfullname);
        res.render('book/form', {
            title: 'Book time off',
            emp: b, types: REQUEST_TYPES, allowance,
            flash: null, form: null,
        });
    } catch (err) { next(err); }
});

// "2026-05-30" + 13.5  ->  Date(2026,4,30,13,30)
function dayAt(ymd, hourFloat) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    if (!m) return null;
    const h = Math.floor(hourFloat);
    const min = Math.round((hourFloat - h) * 60);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, min, 0, 0);
}

router.post('/submit', async (req, res, next) => {
    try {
        const b = bookingEmp(req);
        if (!b) {
            return res.render('book/identify', {
                title: 'Book time off', mode: 'badge',
                flash: 'Your session timed out — please identify yourself again.',
            });
        }

        const settings = await loadSettings();
        const workdayHours = Number(settings.standard_workday_hours) || 8;
        const half = workdayHours / 2;
        const type = String(req.body.request_type || '').toLowerCase();
        const duration = req.body.duration;
        const reason = String(req.body.reason || '').trim().slice(0, 500);

        let startDate = null, endDate = null;
        if (duration === 'half') {
            const pm = req.body.half_part === 'pm';
            startDate = dayAt(req.body.single_date, pm ? DAY_START_HOUR + half : DAY_START_HOUR);
            endDate   = dayAt(req.body.single_date, pm ? DAY_START_HOUR + workdayHours : DAY_START_HOUR + half);
        } else if (duration === 'full') {
            startDate = dayAt(req.body.single_date, DAY_START_HOUR);
            endDate   = dayAt(req.body.single_date, DAY_START_HOUR + workdayHours);
        } else if (duration === 'range') {
            startDate = dayAt(req.body.start_date, DAY_START_HOUR);
            endDate   = dayAt(req.body.end_date, DAY_START_HOUR + workdayHours);
        }

        async function reshow(msg) {
            const allowance = await computeRemainingAllowance(b.empfullname);
            return res.render('book/form', {
                title: 'Book time off',
                emp: b, types: REQUEST_TYPES, allowance,
                flash: msg, form: req.body,
            });
        }

        if (!startDate || !endDate) {
            return reshow('Please choose your date(s).');
        }

        const validation = await validateRequest(b.empfullname, type, startDate, endDate, settings);
        if (!validation.ok) {
            return reshow(validation.reason);
        }

        const skip = await loadNonWorkingDays(startDate, endDate);
        const hours = computeHours(startDate, endDate, workdayHours, skip);
        if (hours <= 0) {
            return reshow('That selection has no working hours in it (check for weekends or bank holidays).');
        }

        await query(
            `INSERT INTO ${t('time_off_requests')}
                (empfullname, request_type, start_datetime, end_datetime,
                 hours_requested, reason, status)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
            [b.empfullname, type,
             formatMysqlDateTime(startDate), formatMysqlDateTime(endDate),
             hours, reason]
        );

        // Notify managers — same channels as the /timeoff portal.
        const notify = settings.timeoff_notify_email || settings.manager_email;
        if (notify) {
            const port = process.env.PORT || 3000;
            sendMail({
                to: notify,
                subject: `[Jondo] Time-off request from ${b.displayname} (${type})`,
                text:
`${b.displayname} (${b.empfullname}) booked time off at the kiosk:

  Type:    ${type}
  From:    ${startDate.toLocaleString()}
  To:      ${endDate.toLocaleString()}
  Hours:   ${hours.toFixed(2)}
  Reason:  ${reason || '(none given)'}

Review it: http://localhost:${port}/timeoff/admin`,
            }).catch(e => console.error('[book] notify mail:', e.message));
        }
        // sendWhatsApp with no settings arg so it loads the full
        // alert_settings row itself (incl. the whatsapp_* columns).
        sendWhatsApp(
            `New time-off request: ${b.displayname} (${type}), ${hours.toFixed(2)}h, `
            + `${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}. `
            + `Review it on the dashboard.`
        ).catch(e => console.error('[book] whatsapp:', e.message));

        const info = {
            displayname: b.displayname,
            type, hours,
            start: startDate.toLocaleString(),
            end: endDate.toLocaleString(),
        };
        req.session.bookEmp = null;
        res.render('book/done', { title: 'Request submitted', info });
    } catch (err) { next(err); }
});

module.exports = router;
