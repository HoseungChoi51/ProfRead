process.env.AFTERDRAFT_PASSWORD='test-owner-password';
process.env.AFTERDRAFT_SESSION_SECRET='test-session-secret-with-more-than-thirty-two-characters';
process.env.AFTERDRAFT_DATA_DIR=`/tmp/afterdraft-vitest-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
process.env.AFTERDRAFT_WEB_DIR='/tmp/afterdraft-no-web-build';
