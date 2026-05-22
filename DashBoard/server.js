// Jondo Time Clock — Node app.
// Serves both the public staff kiosk (clock-in / who's-in board) and
// the admin dashboard (staff CRUD, reports, alerts, time off).

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const staffRoutes = require('./routes/staff');
const scheduleRoutes = require('./routes/schedules');
const reportRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const clockRoutes = require('./routes/clock');
const boardRoutes = require('./routes/board');
const fireRoutes = require('./routes/fire');
const facesRoutes = require('./routes/faces');
const apiRoutes = require('./routes/api');
const portalRoutes = require('./routes/portal');
const timeoffRoutes = require('./routes/timeoff');
const bookoffRoutes = require('./routes/bookoff');
const holidaysRoutes = require('./routes/holidays');
const { requireLogin } = require('./services/auth');
const { startAlertEngine } = require('./services/alerts');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'jondo-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 8,
    },
}));
app.use(flash());

app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    res.locals.path = req.path;
    next();
});

// --- Public staff-facing routes ---
app.use('/', clockRoutes);
app.use('/board', boardRoutes);
app.use('/book', bookoffRoutes);

// --- Admin auth ---
app.use('/admin', authRoutes);
app.use('/', authRoutes);

// --- Protected admin routes ---
app.use('/dashboard', requireLogin, dashboardRoutes);
app.use('/staff', requireLogin, staffRoutes);
app.use('/schedules', requireLogin, scheduleRoutes);
app.use('/reports', requireLogin, reportRoutes);
app.use('/settings', requireLogin, settingsRoutes);
app.use('/fire', fireRoutes);
app.use('/faces', requireLogin, facesRoutes);
app.use('/holidays', requireLogin, holidaysRoutes);

// --- Staff portal + time off (any logged-in employee) ---
app.use('/portal', portalRoutes);
app.use('/timeoff', timeoffRoutes);

// --- Pi-facing API (bearer-token auth, no session) ---
app.use('/api', apiRoutes);

app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
});

app.use((err, req, res, next) => {
    console.error('[unhandled]', err);
    res.status(500).render('error', {
        title: 'Server error',
        message: process.env.NODE_ENV === 'production'
            ? 'Something went wrong.'
            : err.stack || err.message,
    });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
    console.log(`[jondo-dashboard] listening on http://localhost:${port}`);
    startAlertEngine();
});
