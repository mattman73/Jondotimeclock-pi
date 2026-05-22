const express = require('express');
const { authenticate, postLoginRedirect } = require('../services/auth');

const router = express.Router();

router.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect(postLoginRedirect(req.session.user));
    }
    res.render('login', { title: 'Sign in' });
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const emp = await authenticate((username || '').trim(), password || '');
        if (!emp) {
            req.flash('error', 'Invalid username or password, or this account is disabled.');
            return res.redirect('/login');
        }
        req.session.user = {
            empfullname: emp.empfullname,
            displayname: emp.displayname || emp.empfullname,
            email: emp.email,
            admin: emp.admin,
            reports: emp.reports,
            time_admin: emp.time_admin,
        };
        return res.redirect(postLoginRedirect(req.session.user));
    } catch (err) {
        console.error('[login]', err);
        req.flash('error', 'Login failed (database error).');
        return res.redirect('/login');
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
