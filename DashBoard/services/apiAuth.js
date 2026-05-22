// Bearer-token guard for /api/* routes used by the Pi scanner.
// Token comes from PI_API_TOKEN env var. If unset, the API is
// disabled (returns 503) so an unconfigured server doesn't
// accidentally accept anonymous calls.

function bearer(req, res, next) {
    const expected = process.env.PI_API_TOKEN;
    if (!expected) {
        return res.status(503).json({ ok: false, error: 'Pi API disabled (PI_API_TOKEN not set in .env)' });
    }
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (got !== expected) {
        return res.status(401).json({ ok: false, error: 'invalid token' });
    }
    next();
}

module.exports = { bearer };
