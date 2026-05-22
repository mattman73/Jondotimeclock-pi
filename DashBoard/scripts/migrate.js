// Runs every .sql file in sql/ in alphabetical order against the
// configured database. Re-running is safe: CREATE TABLE IF NOT
// EXISTS, INSERT IGNORE, and dup-key errors are swallowed.
//
// Usage:  node scripts/migrate.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function loadStatements(filePath) {
    const sql = fs.readFileSync(filePath, 'utf8');
    return sql
        .split(/;\s*\n/)
        .map(block => block
            .split('\n')
            .filter(line => !/^\s*--/.test(line))
            .join('\n')
            .trim())
        .filter(s => s.length);
}

async function main() {
    const sqlDir = path.join(__dirname, '..', 'sql');
    const files = fs.readdirSync(sqlDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    if (!files.length) {
        console.log('No .sql files in', sqlDir);
        return;
    }

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        multipleStatements: false,
    });

    let failed = false;
    for (const file of files) {
        console.log('--- ' + file + ' ---');
        const statements = loadStatements(path.join(sqlDir, file));
        for (const stmt of statements) {
            const head = stmt.split('\n')[0].slice(0, 80);
            try {
                await conn.query(stmt);
                console.log('OK:', head);
            } catch (e) {
                if (e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_DUP_FIELDNAME') {
                    console.log('SKIP (already exists):', head);
                    continue;
                }
                console.error('FAIL:', head);
                console.error(e.message);
                failed = true;
                break;
            }
        }
        if (failed) break;
    }

    await conn.end();
    if (failed) {
        console.error('Migration aborted with errors.');
        process.exit(1);
    }
    console.log('Migration complete.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
