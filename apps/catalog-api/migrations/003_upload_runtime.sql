ALTER TABLE upload_sessions
  ADD COLUMN IF NOT EXISTS completion_fingerprint text
    CHECK (
      completion_fingerprint IS NULL
      OR completion_fingerprint ~ '^[a-f0-9]{64}$'
    ),
  ADD COLUMN IF NOT EXISTS validation_attempts integer NOT NULL DEFAULT 0
    CHECK (validation_attempts BETWEEN 0 AND 20);

ALTER TABLE validation_jobs
  ADD COLUMN IF NOT EXISTS upload_id uuid REFERENCES upload_sessions(id);

ALTER TABLE validation_jobs
  DROP CONSTRAINT IF EXISTS validation_jobs_job_type_check;

ALTER TABLE validation_jobs
  ADD CONSTRAINT validation_jobs_job_type_check
  CHECK (
    job_type IN (
      'package_hash',
      'package_metadata',
      'malware',
      'yara',
      'media',
      'evidence',
      'publication_preflight'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS validation_jobs_upload_type_unique
  ON validation_jobs(upload_id, job_type)
  WHERE upload_id IS NOT NULL;
