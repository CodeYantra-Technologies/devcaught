// Task 2C verified disposable PostgreSQL only. Keep false until the application's
// actual target database is verified. Activation remains a separate reviewed change;
// privateInboxTargetReady also enforces target readiness on every activated request.
// No request header, environment variable, or browser flag can enable access.
export const PRIVATE_INBOX_POSTGRES_VERIFIED = false;
