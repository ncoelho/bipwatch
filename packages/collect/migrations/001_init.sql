-- Working memory for the collectors (SPEC 6.1). Rebuildable from the sources;
-- the site never reads it.

-- One row per collector run. The last ok run's cursor_after is where the next
-- run starts; failed runs record the error and never advance the cursor.
CREATE TABLE source_runs (
  id             bigserial PRIMARY KEY,
  source         text        NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  ok             boolean,
  items_new      integer     NOT NULL DEFAULT 0,
  items_seen     integer     NOT NULL DEFAULT 0,
  error          text,
  cursor_before  text,
  cursor_after   text
);
CREATE INDEX source_runs_last_ok ON source_runs (source, finished_at DESC) WHERE ok;

-- Append-only archive of what each source returned. content_hash makes
-- re-runs idempotent.
CREATE TABLE raw_items (
  id            bigserial PRIMARY KEY,
  source        text        NOT NULL,
  external_id   text        NOT NULL,
  url           text,
  content_hash  text        NOT NULL UNIQUE,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  content_type  text        NOT NULL,
  body          text        NOT NULL,
  meta          jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX raw_items_source_external ON raw_items (source, external_id);

-- One row per post, comment, message or commit. external_id is the source's
-- own id for the document (post id, Message-ID, commit sha), so an edited post
-- updates its row instead of adding one.
CREATE TABLE documents (
  id            bigserial PRIMARY KEY,
  raw_item_id   bigint      NOT NULL REFERENCES raw_items (id),
  source        text        NOT NULL,
  external_id   text        NOT NULL,
  thread_key    text,
  author        text,
  posted_at     timestamptz,
  title         text,
  body_text     text        NOT NULL,
  url           text,
  search        tsvector GENERATED ALWAYS AS (
                  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                  setweight(to_tsvector('english', body_text), 'B')
                ) STORED,
  UNIQUE (source, external_id)
);
CREATE INDEX documents_thread ON documents (source, thread_key);
CREATE INDEX documents_search ON documents USING gin (search);

CREATE TABLE bip_mentions (
  document_id  bigint  NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  bip          integer NOT NULL,
  method       text    NOT NULL CHECK (method IN ('number', 'link', 'alias', 'thread-title')),
  snippet      text    NOT NULL,
  PRIMARY KEY (document_id, bip, method)
);
CREATE INDEX bip_mentions_bip ON bip_mentions (bip);
