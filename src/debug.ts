import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Opt-in via REVA_DEBUG=1.
//
// WHERE debug output goes matters for correctness here, not just tidiness.
// On a deny, both Kiro hosts read the hook process's ENTIRE stderr and use
// it as the block reason shown to the agent. Each entrypoint logs its raw
// stdin (prompt and tool input included), so writing debug lines to stderr
// would splice all of that into the deny message the model receives.
//
// Default sink when REVA_DEBUG is on: <REVA_DATA_DIR>/debug.log
// (default ~/.kiro/reva-governance/debug.log). REVA_DEBUG_LOG_FILE still
// overrides if you want a different path. stderr is only a last-resort
// fallback when the file cannot be written.
//
// Never throws: a failure to write the log must not affect the decision.

function defaultDebugLogFile(): string | undefined {
  const dir = process.env.REVA_DATA_DIR?.trim() || path.join(os.homedir(), '.kiro', 'reva-governance');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'debug.log');
  } catch {
    return undefined;
  }
}

export function debugLog(message: string): void {
  if (!process.env.REVA_DEBUG) return;
  const line = `[reva-governance] ${message}\n`;
  const logFile = process.env.REVA_DEBUG_LOG_FILE?.trim() || defaultDebugLogFile();
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}`);
      return;
    } catch {
      // Fall through to stderr — losing the trail entirely is worse than
      // the (debug-only) risk of it appearing in a deny reason.
    }
  }
  process.stderr.write(line);
}
