import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withErrorHandler } from '../src/db.ts';

describe('pool error handling', () => {
  it('survives an idle connection being closed by the server', () => {
    // No connection is opened: an 'error' event is what pg emits when a
    // pooled idle client's socket dies.
    const bare = new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/x' });
    expect(() => bare.emit('error', new Error('Connection terminated unexpectedly'))).toThrow();
    const handled = withErrorHandler(new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/x' }));
    expect(() => handled.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
  });
});
