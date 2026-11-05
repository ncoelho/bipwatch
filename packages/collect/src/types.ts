export type SourceId = 'bips-repo' | 'github' | 'delving' | 'mailing-list';

export interface RawItemInput {
  /** The source's own id for this item (commit sha, post id, Message-ID). */
  external_id: string;
  url?: string;
  content_type: string;
  body: string;
  meta?: Record<string, unknown>;
}

export interface RawItem extends RawItemInput {
  id: number;
  source: SourceId;
  content_hash: string;
  fetched_at: Date;
  meta: Record<string, unknown>;
}

export interface DocumentInput {
  /** Stable per document within the source, so edits update one row. */
  external_id: string;
  thread_key?: string;
  /** Title of the thread the document belongs to, for mention inheritance. */
  thread_title?: string;
  author?: string;
  posted_at?: Date;
  title?: string;
  body_text: string;
  url?: string;
}

/** SPEC 6.1 collector contract. */
export interface Collector {
  source: SourceId;
  /** Yields raw items newer than the cursor and the cursor to store after them. */
  fetch(cursor: string | null): AsyncIterable<{ item: RawItemInput; cursor: string }>;
  /** Pure function: raw item to zero or more documents. */
  normalize(raw: RawItem): DocumentInput[];
}

export type MentionMethod = 'number' | 'link' | 'alias' | 'thread-title';

export interface Mention {
  bip: number;
  method: MentionMethod;
  snippet: string;
}
