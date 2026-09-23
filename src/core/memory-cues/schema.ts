export const MEMORY_CUE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_cue_builds (
  id uuid PRIMARY KEY,
  owner_job_id integer REFERENCES minion_jobs(id) ON DELETE SET NULL,
  owner_identity integer NOT NULL,
  source_ids text[] NOT NULL,
  source_incarnations jsonb NOT NULL,
  signature text NOT NULL,
  generation_model text NOT NULL,
  prompt_version text NOT NULL,
  max_usd double precision NOT NULL CHECK (max_usd > 0),
  page_limit integer NOT NULL CHECK (page_limit BETWEEN 1 AND 1000),
  window_limit integer NOT NULL CHECK (window_limit BETWEEN 1 AND 8),
  include_bridge boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued',
  reason text,
  execution_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memory_cue_pages (
  build_id uuid NOT NULL REFERENCES memory_cue_builds(id) ON DELETE CASCADE,
  page_id integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  snapshot text,
  cursor integer NOT NULL DEFAULT 0,
  total_windows integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  PRIMARY KEY(build_id,page_id)
);
CREATE TABLE IF NOT EXISTS memory_cue_windows (
  id uuid PRIMARY KEY,
  build_id uuid NOT NULL REFERENCES memory_cue_builds(id) ON DELETE CASCADE,
  page_id integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_incarnation uuid NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
  revision uuid NOT NULL,
  snapshot text NOT NULL,
  window_index integer NOT NULL,
  signature text NOT NULL,
  prompt_version text NOT NULL,
  generation_model text NOT NULL,
  status text NOT NULL,
  UNIQUE(build_id,page_id,snapshot,window_index)
);
CREATE INDEX IF NOT EXISTS memory_cue_windows_page ON memory_cue_windows(page_id,snapshot);
CREATE TABLE IF NOT EXISTS memory_cue_attempts (
  id uuid PRIMARY KEY,
  build_id uuid NOT NULL REFERENCES memory_cue_builds(id) ON DELETE CASCADE,
  page_id integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  snapshot text NOT NULL,
  window_index integer NOT NULL,
  reserved_cents integer NOT NULL CHECK (reserved_cents > 0),
  settled boolean NOT NULL DEFAULT false,
  actual_cents integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memory_cue_indexes (
  signature text PRIMARY KEY,
  descriptor jsonb NOT NULL,
  index_name text NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_cues (
  id uuid PRIMARY KEY,
  window_id uuid NOT NULL REFERENCES memory_cue_windows(id) ON DELETE CASCADE,
  page_id integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_id integer NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  signature text NOT NULL,
  family text NOT NULL CHECK (family IN ('scene','horizon','bridge')),
  relation text NOT NULL,
  cue_text text NOT NULL CHECK (length(cue_text) BETWEEN 1 AND 240),
  quote text NOT NULL,
  grounding jsonb,
  embedding vector,
  embedding_half halfvec
);
ALTER TABLE memory_cues ADD COLUMN IF NOT EXISTS grounding jsonb;
CREATE INDEX IF NOT EXISTS memory_cues_window ON memory_cues(window_id);
CREATE INDEX IF NOT EXISTS memory_cues_page ON memory_cues(page_id);
CREATE INDEX IF NOT EXISTS memory_cues_signature ON memory_cues(signature);
`;
