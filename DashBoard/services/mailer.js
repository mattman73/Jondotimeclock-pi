// Lightweight nodemailer wrapper. Reads SMTP config from the
// alert_settings table so admins can change it via the Settings UI
// without restarting the server.

const nodemailer = require('nodemailer');
const { query } = require('../db');

let cached = { settingsHash: null, transporter: null };

async function loadSettings() {
    const rows = await query(`SELECT * FROM alert_settings WHERE id = 1`);
    return rows[0] || null;
}

function settingsHash(s) {
    return [s.smtp_host, s.smtp_port, s.smtp_user, s.smtp_pass, s.smtp_from, s.smtp_secure].join('|');
}

async function getTransporter(settings) {
    const hash = settingsHash(settings);
    if (cached.settingsHash === hash && cached.transporter) return cached.transporter;
    if (!settings.smtp_host) return null;
    const transporter = nodemailer.createTransport({
        host: settings.smtp_host,
        port: Number(settings.smtp_port) || 587,
        secure: !!Number(settings.smtp_secure),
        auth: settings.smtp_user
            ? { user: settings.smtp_user, pass: settings.smtp_pass }
            : undefined,
    });
    cached = { settingsHash: hash, transporter };
    return transporter;
}

async function sendMail({ to, subject, text, html }) {
    const settings = await loadSettings();
    if (!settings) return { sent: false, reason: 'no settings row' };
    const transporter = await getTransporter(settings);
    if (!transporter) return { sent: false, reason: 'SMTP not configured' };
    const from = settings.smtp_from || settings.smtp_user || 'jondo-timeclock@localhost';
    try {
        const info = await transporter.sendMail({ from, to, subject, text, html });
        return { sent: true, info };
    } catch (err) {
        console.error('[mailer]', err.message);
        return { sent: false, reason: err.message };
    }
}

module.exports = { sendMail, loadSettings };
