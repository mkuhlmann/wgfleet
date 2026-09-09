process.env.DATABASE_PATH = ':memory:';

import { migrateDb } from '@server/db';
import { mock, afterEach } from 'bun:test';
import * as shellRecording from '@server/wg/shell.recording';

await migrateDb();

process.env.ADMIN_TOKEN = 'adminToken';

// Replaces the whole wg/shell module for every test file (bun:test runs test files
// sequentially in this repo, so the recording adapter's module-level state is safe to
// share) - see shell.recording.ts for what it records and CLAUDE.md's note on the
// wg/shell layer for why every exported function needs an adapter here.
mock.module('@server/wg/shell', () => shellRecording);

afterEach(() => {
	shellRecording.shellCallLog.reset();
});
