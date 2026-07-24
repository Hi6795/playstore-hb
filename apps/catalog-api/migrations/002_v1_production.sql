CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  username text NOT NULL CHECK (length(username) BETWEEN 3 AND 80),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  password_hash text,
  password_algorithm text CHECK (password_algorithm IN ('scrypt', 'argon2id', 'external')),
  external_subject text UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'locked', 'disabled')),
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (lower(username)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('submitter', 'reviewer', 'hardware_tester', 'publisher', 'administrator')),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (user_id, role, granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_active_unique ON user_roles(user_id, role) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_token_hash text NOT NULL CHECK (csrf_token_hash ~ '^[a-f0-9]{64}$'),
  session_version integer NOT NULL CHECK (session_version > 0),
  user_agent_hash text CHECK (user_agent_hash IS NULL OR user_agent_hash ~ '^[a-f0-9]{64}$'),
  ip_prefix inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_from uuid REFERENCES sessions(id),
  revoked_at timestamptz,
  revocation_reason text,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS games (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  title_id text NOT NULL UNIQUE CHECK (title_id ~ '^[A-Z]{4}[0-9]{5}$'),
  content_id text NOT NULL UNIQUE CHECK (content_id ~ '^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_00-[A-Z0-9]{16}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  developer text NOT NULL CHECK (length(developer) BETWEEN 1 AND 120),
  publisher text,
  source_url text NOT NULL CHECK (source_url LIKE 'https://%'),
  homepage_url text CHECK (homepage_url IS NULL OR homepage_url LIKE 'https://%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (id, title_id, content_id)
);

CREATE TABLE IF NOT EXISTS game_submissions (
  id uuid PRIMARY KEY,
  submitter_user_id uuid NOT NULL REFERENCES users(id),
  existing_game_id text REFERENCES games(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft',
    'uploading',
    'upload_incomplete',
    'uploaded',
    'automated_validation',
    'validation_failed',
    'awaiting_submitter_changes',
    'awaiting_content_review',
    'awaiting_legal_review',
    'awaiting_security_review',
    'awaiting_hardware_test',
    'awaiting_final_approval',
    'approved',
    'publishing',
    'published',
    'publication_failed',
    'suspended',
    'revoked',
    'rejected',
    'withdrawn'
  )),
  title_id text NOT NULL CHECK (title_id ~ '^[A-Z]{4}[0-9]{5}$'),
  content_id text NOT NULL CHECK (content_id ~ '^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_00-[A-Z0-9]{16}$'),
  proposed_game_id text NOT NULL CHECK (proposed_game_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  proposed_version text NOT NULL CHECK (proposed_version ~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'),
  document jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS game_submissions_submitter_idx ON game_submissions(submitter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS game_submissions_queue_idx ON game_submissions(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS game_submissions_active_title_idx ON game_submissions(title_id)
  WHERE deleted_at IS NULL AND status NOT IN ('rejected', 'withdrawn', 'revoked');
CREATE UNIQUE INDEX IF NOT EXISTS game_submissions_active_content_idx ON game_submissions(content_id)
  WHERE deleted_at IS NULL AND status NOT IN ('rejected', 'withdrawn', 'revoked');

CREATE TABLE IF NOT EXISTS releases (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE REFERENCES game_submissions(id),
  game_id text REFERENCES games(id),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'),
  title_id text NOT NULL CHECK (title_id ~ '^[A-Z]{4}[0-9]{5}$'),
  content_id text NOT NULL CHECK (content_id ~ '^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_00-[A-Z0-9]{16}$'),
  package_sha256 text UNIQUE CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[a-f0-9]{64}$'),
  package_size_bytes bigint CHECK (package_size_bytes IS NULL OR package_size_bytes > 0),
  package_filename text CHECK (package_filename IS NULL OR package_filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.pkg$'),
  package_category text,
  display_title text,
  changelog text NOT NULL DEFAULT '',
  validation_state text NOT NULL DEFAULT 'pending' CHECK (validation_state IN ('pending', 'running', 'passed', 'failed', 'manual_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (game_id, version),
  UNIQUE (id, package_sha256)
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES game_submissions(id),
  created_by uuid NOT NULL REFERENCES users(id),
  file_id uuid NOT NULL UNIQUE,
  file_kind text NOT NULL CHECK (file_kind IN ('package', 'cover', 'background', 'icon', 'screenshot', 'license', 'redistribution_evidence', 'third_party_notice')),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  safe_filename text NOT NULL CHECK (safe_filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'),
  declared_content_type text NOT NULL CHECK (length(declared_content_type) BETWEEN 1 AND 200),
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes > 0 AND expected_size_bytes <= 53687091200),
  part_size_bytes integer NOT NULL DEFAULT 67108864 CHECK (part_size_bytes BETWEEN 5242880 AND 5368709120),
  maximum_parallel_parts integer NOT NULL DEFAULT 4 CHECK (maximum_parallel_parts BETWEEN 1 AND 4),
  storage_bucket text NOT NULL CHECK (storage_bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  object_key text NOT NULL UNIQUE CHECK (object_key LIKE 'quarantine/submissions/%'),
  provider_upload_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'uploading', 'uploaded', 'aborting', 'aborted', 'expired', 'validation_pending', 'validating', 'validated', 'validation_failed', 'deleted')),
  completed_size_bytes bigint CHECK (completed_size_bytes IS NULL OR completed_size_bytes > 0),
  completed_sha256 text CHECK (completed_sha256 IS NULL OR completed_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  aborted_at timestamptz,
  deleted_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS upload_sessions_owner_active_idx ON upload_sessions(created_by, status, expires_at);
CREATE INDEX IF NOT EXISTS upload_sessions_cleanup_idx ON upload_sessions(expires_at)
  WHERE status IN ('initiated', 'uploading');
CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_active_package_idx ON upload_sessions(submission_id)
  WHERE file_kind = 'package' AND status NOT IN ('aborted', 'expired', 'deleted', 'validation_failed');

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag text NOT NULL CHECK (length(etag) BETWEEN 1 AND 200),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 text CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[A-Za-z0-9+/]{43}=$'),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE IF NOT EXISTS submission_files (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES game_submissions(id),
  upload_id uuid UNIQUE REFERENCES upload_sessions(id),
  file_kind text NOT NULL CHECK (file_kind IN ('package', 'license', 'redistribution_evidence', 'third_party_notice', 'other')),
  private_bucket text NOT NULL,
  private_object_key text NOT NULL UNIQUE,
  detected_content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS submission_files_active_package_idx ON submission_files(submission_id)
  WHERE file_kind = 'package' AND invalidated_at IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS media_files (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES game_submissions(id),
  source_file_id uuid NOT NULL REFERENCES submission_files(id),
  media_kind text NOT NULL CHECK (media_kind IN ('cover', 'background', 'icon', 'screenshot')),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 99),
  source_width integer NOT NULL CHECK (source_width BETWEEN 1 AND 32768),
  source_height integer NOT NULL CHECK (source_height BETWEEN 1 AND 32768),
  derivative_bucket text,
  derivative_object_key text UNIQUE,
  derivative_content_type text,
  derivative_width integer CHECK (derivative_width IS NULL OR derivative_width BETWEEN 1 AND 32768),
  derivative_height integer CHECK (derivative_height IS NULL OR derivative_height BETWEEN 1 AND 32768),
  derivative_size_bytes bigint CHECK (derivative_size_bytes IS NULL OR derivative_size_bytes > 0),
  derivative_sha256 text CHECK (derivative_sha256 IS NULL OR derivative_sha256 ~ '^[a-f0-9]{64}$'),
  validation_state text NOT NULL DEFAULT 'pending' CHECK (validation_state IN ('pending', 'valid', 'invalid', 'manual_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  UNIQUE (submission_id, media_kind, position)
);

CREATE TABLE IF NOT EXISTS validation_jobs (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES game_submissions(id),
  release_id uuid REFERENCES releases(id),
  job_type text NOT NULL CHECK (job_type IN ('package_hash', 'package_metadata', 'malware', 'yara', 'media', 'publication_preflight')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'retryable', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 20),
  maximum_attempts integer NOT NULL DEFAULT 4 CHECK (maximum_attempts BETWEEN 1 AND 20),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS validation_jobs_queue_idx ON validation_jobs(status, scheduled_at);

CREATE TABLE IF NOT EXISTS validation_reports (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES validation_jobs(id),
  submission_id uuid NOT NULL REFERENCES game_submissions(id),
  release_id uuid REFERENCES releases(id),
  package_sha256 text CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[a-f0-9]{64}$'),
  result text NOT NULL CHECK (result IN ('passed', 'failed', 'warning', 'unsupported')),
  report jsonb NOT NULL,
  tool_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scan_results (
  id uuid PRIMARY KEY,
  validation_report_id uuid NOT NULL REFERENCES validation_reports(id),
  scanner_name text NOT NULL,
  scanner_version text,
  signature_database_version text,
  status text NOT NULL CHECK (status IN ('pending', 'clean', 'suspicious', 'infected', 'scan_failed', 'scan_timeout', 'unsupported')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  scanned_at timestamptz NOT NULL,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  UNIQUE (validation_report_id, scanner_name)
);

CREATE TABLE IF NOT EXISTS review_decisions (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES game_submissions(id),
  release_id uuid NOT NULL,
  package_sha256 text NOT NULL,
  review_kind text NOT NULL CHECK (review_kind IN ('content', 'legal', 'security', 'final')),
  decision text NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected')),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  notes text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid REFERENCES review_decisions(id),
  FOREIGN KEY (release_id, package_sha256) REFERENCES releases(id, package_sha256)
);
CREATE INDEX IF NOT EXISTS review_decisions_release_idx ON review_decisions(release_id, review_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS hardware_test_reports (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES game_submissions(id),
  release_id uuid NOT NULL,
  package_sha256 text NOT NULL,
  tester_user_id uuid NOT NULL REFERENCES users(id),
  console_model text NOT NULL CHECK (console_model IN ('fat', 'slim', 'pro')),
  exact_model text NOT NULL,
  firmware_version text NOT NULL,
  homebrew_environment text NOT NULL,
  network_type text NOT NULL,
  storage_type text NOT NULL,
  free_storage_bytes bigint NOT NULL CHECK (free_storage_bytes >= 0),
  build_commit text NOT NULL CHECK (build_commit ~ '^[a-f0-9]{40}$'),
  catalog_sequence bigint NOT NULL CHECK (catalog_sequence >= 0),
  result text NOT NULL CHECK (result IN ('passed', 'failed', 'partial')),
  checklist jsonb NOT NULL,
  evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  tested_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid REFERENCES hardware_test_reports(id),
  FOREIGN KEY (release_id, package_sha256) REFERENCES releases(id, package_sha256)
);
CREATE INDEX IF NOT EXISTS hardware_test_reports_release_idx ON hardware_test_reports(release_id, tested_at DESC);

CREATE TABLE IF NOT EXISTS catalog_versions (
  sequence bigint PRIMARY KEY CHECK (sequence >= 0),
  catalog_version text NOT NULL UNIQUE,
  key_id text NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL,
  manifest jsonb NOT NULL,
  versioned_catalog_key text NOT NULL UNIQUE,
  versioned_signature_key text NOT NULL UNIQUE,
  previous_sequence bigint REFERENCES catalog_versions(sequence),
  published_at timestamptz NOT NULL,
  published_by uuid NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS publications (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES game_submissions(id),
  release_id uuid NOT NULL REFERENCES releases(id),
  publisher_user_id uuid NOT NULL REFERENCES users(id),
  package_sha256 text NOT NULL CHECK (package_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'retryable', 'cancelled')),
  stage text NOT NULL,
  public_package_url text CHECK (public_package_url IS NULL OR public_package_url LIKE 'https://%'),
  public_package_key text UNIQUE,
  catalog_sequence bigint UNIQUE REFERENCES catalog_versions(sequence),
  error_code text,
  error_message text,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (release_id, package_sha256) REFERENCES releases(id, package_sha256)
);
CREATE INDEX IF NOT EXISTS publications_queue_idx ON publications(status, created_at);

CREATE TABLE IF NOT EXISTS publication_events (
  id uuid PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES publications(id),
  stage text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revocations (
  id uuid PRIMARY KEY,
  game_id text NOT NULL REFERENCES games(id),
  release_id uuid NOT NULL REFERENCES releases(id),
  package_sha256 text NOT NULL UNIQUE CHECK (package_sha256 ~ '^[a-f0-9]{64}$'),
  reason_code text NOT NULL,
  reason_public text NOT NULL,
  evidence_private jsonb NOT NULL DEFAULT '{}'::jsonb,
  revoked_by uuid NOT NULL REFERENCES users(id),
  revoked_at timestamptz NOT NULL,
  catalog_sequence bigint REFERENCES catalog_versions(sequence),
  restored_by uuid REFERENCES users(id),
  restored_at timestamptz,
  CHECK ((restored_by IS NULL) = (restored_at IS NULL))
);

CREATE TABLE IF NOT EXISTS download_aggregates (
  day date NOT NULL,
  game_id text NOT NULL REFERENCES games(id),
  release_id uuid NOT NULL REFERENCES releases(id),
  starts bigint NOT NULL DEFAULT 0 CHECK (starts >= 0),
  completions bigint NOT NULL DEFAULT 0 CHECK (completions >= 0),
  verification_failures bigint NOT NULL DEFAULT 0 CHECK (verification_failures >= 0),
  bytes_served numeric(24, 0) NOT NULL DEFAULT 0 CHECK (bytes_served >= 0),
  PRIMARY KEY (day, release_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  actor_subject text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  submission_id uuid REFERENCES game_submissions(id),
  upload_id uuid REFERENCES upload_sessions(id),
  release_id uuid REFERENCES releases(id),
  publication_id uuid REFERENCES publications(id),
  catalog_sequence bigint REFERENCES catalog_versions(sequence),
  source_ip inet,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_event_hash text CHECK (previous_event_hash IS NULL OR previous_event_hash ~ '^[a-f0-9]{64}$'),
  event_hash text NOT NULL UNIQUE CHECK (event_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS audit_events_time_idx ON audit_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_submission_idx ON audit_events(submission_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  actor_subject text NOT NULL,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  response_status integer NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (actor_subject, scope, idempotency_key),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idempotency_records_expiry_idx ON idempotency_records(expires_at);

CREATE TABLE IF NOT EXISTS allowed_submission_transitions (
  from_status text NOT NULL,
  to_status text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO allowed_submission_transitions(from_status, to_status) VALUES
  ('draft', 'uploading'),
  ('draft', 'withdrawn'),
  ('uploading', 'upload_incomplete'),
  ('uploading', 'uploaded'),
  ('uploading', 'withdrawn'),
  ('upload_incomplete', 'uploading'),
  ('upload_incomplete', 'withdrawn'),
  ('uploaded', 'automated_validation'),
  ('automated_validation', 'validation_failed'),
  ('automated_validation', 'awaiting_content_review'),
  ('validation_failed', 'awaiting_submitter_changes'),
  ('awaiting_submitter_changes', 'uploading'),
  ('awaiting_submitter_changes', 'withdrawn'),
  ('awaiting_content_review', 'awaiting_legal_review'),
  ('awaiting_content_review', 'awaiting_submitter_changes'),
  ('awaiting_content_review', 'rejected'),
  ('awaiting_legal_review', 'awaiting_security_review'),
  ('awaiting_legal_review', 'awaiting_submitter_changes'),
  ('awaiting_legal_review', 'rejected'),
  ('awaiting_security_review', 'awaiting_hardware_test'),
  ('awaiting_security_review', 'awaiting_submitter_changes'),
  ('awaiting_security_review', 'rejected'),
  ('awaiting_hardware_test', 'awaiting_final_approval'),
  ('awaiting_hardware_test', 'awaiting_submitter_changes'),
  ('awaiting_hardware_test', 'rejected'),
  ('awaiting_final_approval', 'approved'),
  ('awaiting_final_approval', 'awaiting_submitter_changes'),
  ('awaiting_final_approval', 'rejected'),
  ('approved', 'publishing'),
  ('publishing', 'published'),
  ('publishing', 'publication_failed'),
  ('publication_failed', 'publishing'),
  ('published', 'suspended'),
  ('published', 'revoked'),
  ('suspended', 'published'),
  ('suspended', 'revoked')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS submission_state_events (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES game_submissions(id),
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  package_sha256 text CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION guard_submission_status_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND current_setting('playstorehb.authorized_transition', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'submission status changes must use transition_submission()';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS game_submissions_status_guard ON game_submissions;
CREATE TRIGGER game_submissions_status_guard
BEFORE UPDATE OF status ON game_submissions
FOR EACH ROW EXECUTE FUNCTION guard_submission_status_update();

CREATE OR REPLACE FUNCTION transition_submission(
  p_submission_id uuid,
  p_expected_status text,
  p_expected_row_version bigint,
  p_to_status text,
  p_actor_user_id uuid,
  p_reason text,
  p_event_id uuid,
  p_package_sha256 text DEFAULT NULL
)
RETURNS game_submissions
LANGUAGE plpgsql
AS $$
DECLARE
  current_submission game_submissions;
  updated_submission game_submissions;
BEGIN
  SELECT * INTO current_submission
  FROM game_submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found';
  END IF;
  IF current_submission.status <> p_expected_status
     OR current_submission.row_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'submission state conflict';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM allowed_submission_transitions
    WHERE from_status = current_submission.status AND to_status = p_to_status
  ) THEN
    RAISE EXCEPTION 'invalid submission transition: % -> %', current_submission.status, p_to_status;
  END IF;
  IF p_actor_user_id IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'transition actor and reason are required';
  END IF;

  PERFORM set_config('playstorehb.authorized_transition', 'yes', true);
  UPDATE game_submissions
  SET status = p_to_status,
      row_version = row_version + 1,
      updated_at = now(),
      submitted_at = CASE WHEN p_to_status = 'uploaded' THEN now() ELSE submitted_at END
  WHERE id = p_submission_id
  RETURNING * INTO updated_submission;
  PERFORM set_config('playstorehb.authorized_transition', '', true);

  INSERT INTO submission_state_events(
    id, submission_id, from_status, to_status, actor_user_id, reason, package_sha256
  ) VALUES (
    p_event_id, p_submission_id, current_submission.status, p_to_status,
    p_actor_user_id, p_reason, p_package_sha256
  );

  RETURN updated_submission;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

DROP TRIGGER IF EXISTS validation_reports_append_only ON validation_reports;
CREATE TRIGGER validation_reports_append_only
BEFORE UPDATE OR DELETE ON validation_reports
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

DROP TRIGGER IF EXISTS scan_results_append_only ON scan_results;
CREATE TRIGGER scan_results_append_only
BEFORE UPDATE OR DELETE ON scan_results
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

DROP TRIGGER IF EXISTS review_decisions_append_only ON review_decisions;
CREATE TRIGGER review_decisions_append_only
BEFORE UPDATE OR DELETE ON review_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

DROP TRIGGER IF EXISTS hardware_test_reports_append_only ON hardware_test_reports;
CREATE TRIGGER hardware_test_reports_append_only
BEFORE UPDATE OR DELETE ON hardware_test_reports
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

DROP TRIGGER IF EXISTS catalog_versions_append_only ON catalog_versions;
CREATE TRIGGER catalog_versions_append_only
BEFORE UPDATE OR DELETE ON catalog_versions
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

DROP TRIGGER IF EXISTS publication_events_append_only ON publication_events;
CREATE TRIGGER publication_events_append_only
BEFORE UPDATE OR DELETE ON publication_events
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
