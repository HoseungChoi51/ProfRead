process.env.CO_READER_PASSWORD='test-owner-password';
process.env.CO_READER_SESSION_SECRET='test-session-secret-with-more-than-thirty-two-characters';
process.env.CO_READER_DATA_DIR=`/tmp/co-reader-vitest-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
process.env.CO_READER_WEB_DIR='/tmp/co-reader-no-web-build';
