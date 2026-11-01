/** Select the Vite dev bind; network access requires an explicit opt-in. */
export function devServerHost(env = process.env) {
  return env.DEVCAUGHT_LIVE_PREVIEW === "1" ? "0.0.0.0" : "127.0.0.1";
}
