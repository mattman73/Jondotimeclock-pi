-- ============================================================
-- Face recognition schema additions.
--
-- Reference photos are stored in face_enrollments. Computed
-- embeddings live ONLY on the Pi (the Pi rebuilds them locally).
-- The Pi can re-derive everything from the photos at any time, so
-- we don't need to store embeddings in MySQL.
--
-- face_opt_in is an EXPLICIT consent flag. The Pi service will
-- only consider photos for employees with face_opt_in = 1. This
-- maps to UK GDPR "explicit consent" basis for biometrics.
-- ============================================================

-- Reference photos (1..N per employee). LONGBLOB holds up to 4GB
-- but in practice we cap to a few hundred KB per image.
CREATE TABLE IF NOT EXISTS face_enrollments (
    id            INT          NOT NULL AUTO_INCREMENT,
    empfullname   VARCHAR(50)  NOT NULL,
    image_blob    LONGBLOB     NOT NULL,
    image_mime    VARCHAR(40)  NOT NULL DEFAULT 'image/jpeg',
    captured_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    captured_by   VARCHAR(50)  NOT NULL DEFAULT '',
    deleted_at    DATETIME     NULL,
    PRIMARY KEY (id),
    KEY idx_emp (empfullname),
    KEY idx_active (deleted_at)
);

-- Every match attempt the Pi makes, for compliance audit and
-- debugging confidence thresholds. Keep retention short — purge
-- rows older than 90 days unless explicitly preserved.
CREATE TABLE IF NOT EXISTS face_audit (
    id           INT          NOT NULL AUTO_INCREMENT,
    empfullname  VARCHAR(50)  NULL,
    confidence   DECIMAL(4,3) NULL,
    action       VARCHAR(30)  NOT NULL,    -- matched / rejected / no_face / spoof / error
    reason       VARCHAR(120) NOT NULL DEFAULT '',
    pi_host      VARCHAR(80)  NOT NULL DEFAULT '',
    captured_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_emp (empfullname),
    KEY idx_when (captured_at)
);

-- Add the consent flag and a "deleted on request" timestamp to
-- the legacy employees table.
ALTER TABLE employees ADD COLUMN face_opt_in TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN face_consent_at DATETIME NULL;
