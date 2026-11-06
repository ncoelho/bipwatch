-- Small key/value store for index bookkeeping. 'mention_context' holds a
-- fingerprint of the mention rules (tracked BIPs' aliases) the archive was
-- last tagged with, so `reindex-mentions --if-changed` only rereads the
-- archive when those rules change.

CREATE TABLE index_state (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
