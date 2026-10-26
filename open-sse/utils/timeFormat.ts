/**
 * Clock formatting for stream/usage log lines.
 *
 * `Date#toLocaleTimeString` with an options object costs ~60-77us per call
 * (measured on this repo, ICU option resolution every time), and the request
 * path formats a timestamp for every line it prints — 3 to 6 per chat request.
 * That is up to ~400us of pure formatting per request, i.e. more CPU than the
 * entire usage write.
 *
 * These helpers produce byte-identical "HH:MM:SS" / "HH:MM" strings with plain
 * arithmetic (~3.5us), so hot callers can stop paying ICU for a clock.
 */

const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);

/** "HH:MM:SS" in local time — same output as toLocaleTimeString(en-US, hour12:false). */
export function formatClockTime(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** "HH:MM" in local time — same output as toLocaleTimeString(en-US, {hour,minute,hour12:false}). */
export function formatClockHourMinute(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
