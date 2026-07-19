CREATE TABLE IF NOT EXISTS submissions(id text PRIMARY KEY, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_log(id uuid PRIMARY KEY, at timestamptz NOT NULL, actor text NOT NULL, action text NOT NULL, resource text NOT NULL, request_id text NOT NULL, details jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS published_catalog(sequence bigint PRIMARY KEY, manifest jsonb NOT NULL, signature text NOT NULL, published_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS idempotency_keys(scope text NOT NULL, key text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,key));
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at DESC);
