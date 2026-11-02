"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.debugLog = debugLog;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
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
function defaultDebugLogFile() {
    const dir = process.env.REVA_DATA_DIR?.trim() || path.join(os.homedir(), '.kiro', 'reva-governance');
    try {
        fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, 'debug.log');
    }
    catch {
        return undefined;
    }
}
function debugLog(message) {
    if (!process.env.REVA_DEBUG)
        return;
    const line = `[reva-governance] ${message}\n`;
    const logFile = process.env.REVA_DEBUG_LOG_FILE?.trim() || defaultDebugLogFile();
    if (logFile) {
        try {
            fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}`);
            return;
        }
        catch {
            // Fall through to stderr — losing the trail entirely is worse than
            // the (debug-only) risk of it appearing in a deny reason.
        }
    }
    process.stderr.write(line);
}
