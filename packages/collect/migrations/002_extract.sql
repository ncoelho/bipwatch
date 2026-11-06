-- LLM extraction bookkeeping (SPEC 6.2). One row per run of a task, and one
-- log row per document the run looked at, so every claim a model proposed,
-- and every one it dropped, can be traced back to its input and tokens.

CREATE TABLE extract_runs (
  id              bigserial PRIMARY KEY,
  task            text        NOT NULL,
  task_version    integer     NOT NULL,
  model           text        NOT NULL,
  dry_run         boolean     NOT NULL DEFAULT false,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  ok              boolean,
  -- Documents are processed in id order; the last ok non-dry run's
  -- cursor_after is where the next run starts.
  cursor_before   bigint,
  cursor_after    bigint,
  docs_seen       integer     NOT NULL DEFAULT 0,
  claims_written  integer     NOT NULL DEFAULT 0,
  input_tokens    bigint      NOT NULL DEFAULT 0,
  output_tokens   bigint      NOT NULL DEFAULT 0,
  stopped_by      text,       -- 'done', 'budget', 'limit', 'error'
  error           text
);
CREATE INDEX extract_runs_last_ok ON extract_runs (task, finished_at DESC) WHERE ok AND NOT dry_run;

CREATE TABLE extract_log (
  run_id        bigint  NOT NULL REFERENCES extract_runs (id) ON DELETE CASCADE,
  document_id   bigint  NOT NULL REFERENCES documents (id),
  -- 'claims': at least one claim passed; 'none': the model found nothing;
  -- 'invalid': every proposed claim failed validation after one retry;
  -- 'refusal', 'too_long', 'error': no usable output.
  outcome       text    NOT NULL CHECK (outcome IN ('claims', 'none', 'invalid', 'refusal', 'too_long', 'error')),
  attempts      integer NOT NULL DEFAULT 0,
  claim_ids     text[]  NOT NULL DEFAULT '{}',
  -- Validation errors and dropped proposals, for building the eval set.
  rejected      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, document_id)
);
