process.env.DATABASE_PATH = ':memory:';

import { migrateDb } from '@server/db';
import { mock, afterEach } from 'bun:test';
import { recordingHost, shellCallLog } from '@server/wg/shell.recording';

await migrateDb();

process.env.ADMIN_TOKEN = 'adminToken';

// Replaces the whole wg/shell module for every test file (bun:test runs test files
// sequentially in this repo, so the recording adapter's module-level state is safe to share).
// The exports are spread from `recordingHost`, which is typed `WgHost` (wg/host.ts), so
// anything added to the seam arrives here automatically - there is no per-function list to
// keep in sync.
mock.module('@server/wg/shell', () => ({ ...recordingHost, shellCallLog }));

afterEach(() => {
	shellCallLog.reset();
});
