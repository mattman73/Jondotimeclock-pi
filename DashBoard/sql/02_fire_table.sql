-- One row per employee currently marked "accounted for" in the
-- in-progress fire/evac drill. Truncated when the manager taps
-- "End drill". Persisting it (instead of keeping it in memory)
-- means a server restart in the middle of a drill doesn't lose
-- the roll-call state.
CREATE TABLE IF NOT EXISTS fire_accounted (
    empfullname VARCHAR(50) NOT NULL,
    accounted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accounted_by VARCHAR(50) NOT NULL DEFAULT '',
    PRIMARY KEY (empfullname)
);
