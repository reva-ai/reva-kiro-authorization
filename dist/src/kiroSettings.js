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
exports.resolveKiroHome = resolveKiroHome;
exports.resolveGlobalCliJsonPath = resolveGlobalCliJsonPath;
exports.resolveWorkspaceCliJsonPath = resolveWorkspaceCliJsonPath;
exports.readKiroCliEnv = readKiroCliEnv;
exports.applyKiroCliEnv = applyKiroCliEnv;
exports.mergeEnvWithKiroCli = mergeEnvWithKiroCli;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
// Kiro's durable CLI settings live at ~/.kiro/settings/cli.json (or
// $KIRO_HOME/settings/cli.json). A top-level `env` object is how operators
// pin REVA_* without exporting them in every shell that launches Kiro —
// hooks inherit the parent process env, but neither host's hook config has
// an `env` field of its own (see README).
//
// Shape confirmed on a real install (`kiro-cli settings` / the file itself):
//
//   {
//     "env": {
//       "REVA_AUTH_TOKEN": "…",
//       "REVA_HOST": "api.example.reva.ai",
//       "REVA_DEBUG": "1"
//     }
//   }
//
// Workspace `<cwd>/.kiro/settings/cli.json` overrides the global file when
// present (Kiro's own settings merge rule). Missing/malformed files are
// silent — there is simply nothing to apply.
function resolveKiroHome(env = process.env) {
    const fromEnv = env.KIRO_HOME?.trim();
    return fromEnv || path.join(os.homedir(), '.kiro');
}
function resolveGlobalCliJsonPath(env = process.env) {
    return path.join(resolveKiroHome(env), 'settings', 'cli.json');
}
function resolveWorkspaceCliJsonPath(cwd) {
    return path.join(cwd, '.kiro', 'settings', 'cli.json');
}
function readEnvBlockFromFile(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return {};
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        return {};
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return {};
    const out = {};
    const root = data;
    const envBlock = root.env;
    if (envBlock && typeof envBlock === 'object' && !Array.isArray(envBlock)) {
        for (const [key, value] of Object.entries(envBlock)) {
            if (typeof value === 'string' && value.length > 0)
                out[key] = value;
        }
    }
    // Also accept top-level REVA_* — not the documented Kiro shape, but
    // harmless if someone puts them there by habit.
    for (const [key, value] of Object.entries(root)) {
        if (key.startsWith('REVA_') && typeof value === 'string' && value.length > 0 && out[key] === undefined) {
            out[key] = value;
        }
    }
    return out;
}
/**
 * Returns the string map from Kiro cli.json `env` (global, then workspace
 * overrides). Empty object when nothing is configured.
 */
function readKiroCliEnv(options = {}) {
    const env = options.env || process.env;
    if (options.settingsPath) {
        return readEnvBlockFromFile(options.settingsPath);
    }
    const overridePath = env.REVA_KIRO_SETTINGS_PATH?.trim();
    if (overridePath) {
        return readEnvBlockFromFile(overridePath);
    }
    const globalEnv = readEnvBlockFromFile(resolveGlobalCliJsonPath(env));
    const cwd = options.cwd || process.cwd();
    const workspaceEnv = readEnvBlockFromFile(resolveWorkspaceCliJsonPath(cwd));
    return { ...globalEnv, ...workspaceEnv };
}
/**
 * Fills gaps in `env` from cli.json. Existing non-empty process values win,
 * so a one-shot `export REVA_HOST=…` still overrides the durable file for
 * that session. Mutates `env` in place (normally `process.env`) so debug.ts
 * and anything else that reads process.env directly also sees the values.
 */
function applyKiroCliEnv(env = process.env, options = {}) {
    const fromFile = readKiroCliEnv({ ...options, env });
    for (const [key, value] of Object.entries(fromFile)) {
        if (env[key] === undefined || env[key] === '') {
            env[key] = value;
        }
    }
}
/**
 * Merge for loadConfig: cli.json as base, then `env` overrides. Empty-string
 * process values do not wipe a file value — same rule as applyKiroCliEnv.
 */
function mergeEnvWithKiroCli(env = process.env, options = {}) {
    const fromFile = readKiroCliEnv({ ...options, env });
    const merged = { ...fromFile };
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && value !== '')
            merged[key] = value;
    }
    return merged;
}
