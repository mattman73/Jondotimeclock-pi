// Shared MySQL connection pool. mysql2/promise so routes can `await`.
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'timeclock',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'timeclock',
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true,
    dateStrings: true,
});

// Tiny helper so callers don't have to destructure [rows] every time.
async function query(sql, params) {
    const [rows] = await pool.execute(sql, params || []);
    return rows;
}

// Optional table prefix support to mirror the PHP $db_prefix setting.
const prefix = process.env.DB_PREFIX || '';
function t(name) {
    return `\`${prefix}${name}\``;
}

module.exports = { pool, query, t };
