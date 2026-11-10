// Minimal structured logger with levels; errors are also kept in a ring buffer for the dev overlay.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;
export const recentErrors: { at: number; msg: string }[] = [];

function out(level: Level, args: unknown[]) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const msg = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (level === 'error' || level === 'warn') {
    recentErrors.push({ at: Date.now(), msg: line });
    if (recentErrors.length > 100) recentErrors.shift();
    console.error(line);
  } else console.log(line);
}

export const log = {
  debug: (...a: unknown[]) => out('debug', a),
  info: (...a: unknown[]) => out('info', a),
  warn: (...a: unknown[]) => out('warn', a),
  error: (...a: unknown[]) => out('error', a),
};
