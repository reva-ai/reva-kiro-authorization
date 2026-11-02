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
exports.osFamily = osFamily;
exports.readSessionModel = readSessionModel;
exports.readSessionRecordModel = readSessionRecordModel;
exports.readCachedKiroDefaultModel = readCachedKiroDefaultModel;
exports.recordKiroDefaultModel = recordKiroDefaultModel;
exports.recordLaunchModel = recordLaunchModel;
exports.resolveSessionModelWithSource = resolveSessionModelWithSource;
exports.resolveSessionModel = resolveSessionModel;
exports.describeModel = describeModel;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
// Host-specific facts that enrich the Agent entity and the evaluation
// context (`operatingSystems`, `models`).
// The OS family this machine runs, as an Agent `operatingSystems` Set value.
// A fixed vocabulary — "one attribute name, one meaning" applies to values
// too, or a policy written against `operatingSystems contains "windows"`
// silently stops matching when the same OS is reported as "win32".
function osFamily(platform = process.platform) {
    switch (platform) {
        case 'win32':
            return 'windows';
        case 'darwin':
            return 'macos';
        case 'linux':
            return 'linux';
        default:
            return platform;
    }
}
// The model backing this Kiro session, or undefined.
//
// Kiro does not put the model on the hook payload. Confirmed by probing
// what a hook actually receives (re-checked on kiro-cli 2.36.0): the
// payload carries only {hook_event_name, cwd, session_id, tool_name,
// tool_input, prompt}, and the only Kiro-set environment variables are
// KIRO_SESSION_ID, KIRO_CLI_ACP_CLIENT_NAME and KIRO_CLI_IS_CHILD_PROCESS.
// There is no model field in either.
//
// What Kiro does have is its own per-session record — an undocumented
// internal format, read strictly best-effort: any failure or shape surprise
// and the field is simply omitted. Two layouts, one per host:
//
//   kiro-cli  ~/.kiro/sessions/cli/<sessionId>.json
//             session_state.rts_model_state.model_info.model_id   (current)
//             session_state.conversation_metadata.user_turn_metadatas[N].model
//             session_state.conversation_metadata.last_context_usage.model_id
//   Kiro IDE  ~/.kiro/sessions/<workspace hash>/<sessionId>/session.json
//             modelId, contextSnapshotModelDisplay.modelId
//
// The CURRENT model is read first (rts_model_state, then the LAST turn's
// model), so a mid-session model switch is reported as the new model rather
// than whichever turn happened to come first in the file.
//
// Kiro's own default is the literal "auto" — Kiro picks the underlying model
// per request on its servers and never records which one locally. "auto" is
// passed through verbatim: it is the honest answer, and inventing a concrete
// model to stand in for it would be exactly the guess this project forbids.
// A model the user CHOSE (`--model claude-haiku-4.5`, `/model`, the IDE's
// model picker) is recorded by Kiro by name, and reported by name.
function readSessionModel(sessionId, homeDir = os.homedir()) {
    return readSessionRecordModel(sessionId, homeDir)?.model;
}
// The record's model, and whether it can be trusted yet. A kiro-cli record
// with no completed turn holds a PLACEHOLDER: Kiro writes "auto" there at
// session creation and only records the real model after the first turn
// finishes — so during turn one, a session started with `--model X` still
// says "auto" (confirmed on 2.36.0). An IDE record has no turn list and
// is taken as written.
function readSessionRecordModel(sessionId, homeDir = os.homedir()) {
    if (!sessionId)
        return undefined;
    // Guard against a session id that is not a bare filename — it comes from
    // a host payload / env var, and a value containing path separators must
    // never be allowed to walk out of the sessions directory.
    if (sessionId !== path.basename(sessionId))
        return undefined;
    for (const file of sessionRecordFiles(sessionId, homeDir)) {
        try {
            const record = JSON.parse(fs.readFileSync(file, 'utf8'));
            const model = currentModel(record);
            if (!model)
                continue;
            const turns = record?.session_state?.conversation_metadata?.user_turn_metadatas;
            const isCliRecord = record?.session_state !== undefined;
            return { model, authoritative: !isCliRecord || (Array.isArray(turns) && turns.length > 0) };
        }
        catch {
            // absent or unreadable — try the next layout
        }
    }
    return undefined;
}
function sessionRecordFiles(sessionId, homeDir) {
    const root = path.join(homeDir, '.kiro', 'sessions');
    const files = [path.join(root, 'cli', `${sessionId}.json`)];
    try {
        for (const dir of fs.readdirSync(root)) {
            if (dir !== 'cli')
                files.push(path.join(root, dir, sessionId, 'session.json'));
        }
    }
    catch {
        // no sessions directory at all
    }
    return files;
}
function nonEmpty(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
// The model this session is using NOW, from the known locations in order,
// then a generic search as a fallback for a layout a Kiro update changed.
function currentModel(record) {
    const state = record?.session_state;
    const turns = state?.conversation_metadata?.user_turn_metadatas;
    const lastTurn = Array.isArray(turns) ? turns[turns.length - 1] : undefined;
    return (nonEmpty(state?.rts_model_state?.model_info?.model_id) ||
        nonEmpty(state?.rts_model_state?.model_info?.model_name) ||
        nonEmpty(lastTurn?.model) ||
        nonEmpty(state?.conversation_metadata?.last_context_usage?.model_id) ||
        nonEmpty(record?.modelId) ||
        nonEmpty(record?.contextSnapshotModelDisplay?.modelId) ||
        findModel(record));
}
// Every spelling of the key seen in a real session record, plus the two
// camelCase forms an earlier probe reported.
const MODEL_KEYS = ['model', 'modelId', 'model_id', 'modelName', 'model_name'];
// Depth-limited search for the first model-ish string — only reached when
// none of the known locations above has one.
function findModel(node, depth = 0) {
    if (depth > 6 || node == null || typeof node !== 'object')
        return undefined;
    const record = node;
    for (const key of MODEL_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    for (const value of Object.values(record)) {
        const found = findModel(value, depth + 1);
        if (found)
            return found;
    }
    return undefined;
}
// --- this session's own memo -------------------------------------------------
//
// The last model resolved for THIS session id, so a hook that runs while
// Kiro is mid-way through rewriting its record still reports the session's
// model. Keyed per session, deliberately: an earlier version kept ONE memo
// across all sessions, and a brand-new session then reported the previous
// session's model — confirmed in practice, when a session started with
// `--model claude-haiku-4.5` was reported as "auto".
function memoFile(sessionId, dataDir) {
    if (!dataDir || !sessionId)
        return undefined;
    return path.join(dataDir, 'session-models', `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}
function readMemo(sessionId, dataDir) {
    const file = memoFile(sessionId, dataDir);
    if (!file)
        return undefined;
    try {
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        const model = nonEmpty(entry?.model);
        if (!model)
            return undefined;
        return { model, source: entry?.source === 'kiro-cli --model flag' ? 'kiro-cli --model flag' : 'session memo' };
    }
    catch {
        return undefined;
    }
}
function writeMemo(sessionId, model, dataDir, source = 'session memo') {
    const file = memoFile(sessionId, dataDir);
    if (!file)
        return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ model, source, resolvedAt: Date.now() }), 'utf8');
    }
    catch {
        // best effort — the next hook resolves it again
    }
}
// --- Kiro's default model (global, not per session) ---------------------------
//
// What a session uses when nothing chose a model — read from kiro-cli at
// session start (launchModel.ts) and cached here, because looking it up
// costs ~2.4s. This is a fact about Kiro, not another session's model, so it
// is safe to share across sessions. Refreshed at most once a day.
const DEFAULT_MODEL_TTL_MS = 24 * 60 * 60 * 1000;
function defaultModelFile(dataDir) {
    return dataDir ? path.join(dataDir, 'kiro-default-model.json') : undefined;
}
function readCachedKiroDefaultModel(dataDir) {
    const file = defaultModelFile(dataDir);
    if (!file)
        return { fresh: false };
    try {
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        const model = nonEmpty(entry?.model);
        const fresh = typeof entry?.resolvedAt === 'number' && Date.now() - entry.resolvedAt < DEFAULT_MODEL_TTL_MS;
        return { model, fresh };
    }
    catch {
        return { fresh: false };
    }
}
function recordKiroDefaultModel(model, dataDir) {
    const file = defaultModelFile(dataDir);
    if (!file)
        return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ model, resolvedAt: Date.now() }), 'utf8');
    }
    catch {
        // best effort
    }
}
// Called once at session start with the model the kiro-cli session was
// launched with (see launchModel.ts), so every hook of the first turn —
// before Kiro records the model itself — reports the chosen model.
function recordLaunchModel(sessionId, model, dataDir) {
    writeMemo(sessionId, model, dataDir, 'kiro-cli --model flag');
}
// The user's configured default model (`kiro-cli settings chat.defaultModel
// <model>`), from Kiro's own settings file. What a new session starts with
// unless `--model` or `/model` picks another.
function readDefaultModelSetting(env, homeDir) {
    const kiroHome = env.KIRO_HOME?.trim() || path.join(homeDir, '.kiro');
    try {
        const settings = JSON.parse(fs.readFileSync(path.join(kiroHome, 'settings', 'cli.json'), 'utf8'));
        return nonEmpty(settings?.['chat.defaultModel']);
    }
    catch {
        return undefined;
    }
}
// What the hooks actually call, with where the answer came from (logged, so
// "why does this decision say model X" can always be answered). In order:
//
//   1. REVA_MODEL — an explicit pin always wins.
//   2. This session's Kiro record, once it holds a completed turn — the
//      model in use now, including after a `/model` switch.
//   3. This session's own memo: the last model step 2 found, or the
//      launch `--model` flag recorded at session start.
//   4. The user's default model setting (`chat.defaultModel`), if set.
//   5. The record's own value before any turn completed — Kiro's default,
//      "auto", which is accurate when nothing above chose a model.
//   6. Kiro's default model (`kiro-cli chat --list-models`, cached). Covers
//      the start of a session whose record has NO model yet — observed
//      live: `model_info: null` until the first turn ended — so the model
//      is never missing just because Kiro has not written it yet.
//
// Undefined only when even Kiro's default is unknown (kiro-cli never
// reachable), and then `model` is omitted. Never another session's model:
// that was the old fallback, and it reported the wrong one.
function resolveSessionModelWithSource(sessionId, env = process.env, homeDir = os.homedir(), dataDir) {
    const override = env.REVA_MODEL?.trim();
    if (override)
        return { model: override, source: 'REVA_MODEL' };
    const record = readSessionRecordModel(sessionId, homeDir);
    if (record?.authoritative) {
        writeMemo(sessionId, record.model, dataDir);
        return { model: record.model, source: 'session record' };
    }
    const memo = readMemo(sessionId, dataDir);
    if (memo)
        return memo;
    const setting = readDefaultModelSetting(env, homeDir);
    if (setting)
        return { model: setting, source: 'default model setting' };
    if (record)
        return { model: record.model, source: "session record (Kiro's default)" };
    const kiroDefault = readCachedKiroDefaultModel(dataDir).model;
    if (kiroDefault)
        return { model: kiroDefault, source: 'Kiro default model' };
    return {};
}
function resolveSessionModel(sessionId, env = process.env, homeDir = os.homedir(), dataDir) {
    return resolveSessionModelWithSource(sessionId, env, homeDir, dataDir).model;
}
// One debug-log line, the same from every hook.
function describeModel(resolved) {
    return resolved.model ? `${resolved.model} (from ${resolved.source})` : '(not known yet — Kiro has not recorded it for this session)';
}
