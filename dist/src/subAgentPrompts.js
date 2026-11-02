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
exports.recordSubAgentPrompts = recordSubAgentPrompts;
exports.claimSubAgentPrompt = claimSubAgentPrompt;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// Remembers the instructions handed to sub-agents, so the prompt hook can
// tell "a sub-agent starting" apart from "the user starting a new turn".
//
// Why: the Kiro IDE submits a sub-agent's instructions as a prompt event of
// its own, in the parent's session. Captured from a real session: the 4th
// `invoke_sub_agent` call's `prompt` (1,582 chars, "You are Subagent 4 of
// 4…") arrived 5s later as a userPromptSubmit with byte-identical text.
// Every prompt event starts a new turn and resets the per-turn sub-agent
// counter — so without this, that sub-agent was counted as #1, not #4.
//
// Only a fingerprint of each prompt is stored, never the text. A recorded
// prompt is claimed once (the first matching prompt event) and expires
// after a while, so a user who later types the same words starts a turn as
// normal. Best effort throughout: any failure just means "not a sub-agent".
const TTL_MS = 30 * 60 * 1000;
function fingerprint(prompt) {
    return (0, node_crypto_1.createHash)('sha256').update(prompt.trim()).digest('hex');
}
function file(sessionId, dataDir) {
    if (!dataDir || !sessionId)
        return undefined;
    return path.join(dataDir, 'subagent-prompts', `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}
function load(f) {
    try {
        const entries = JSON.parse(fs.readFileSync(f, 'utf8'));
        return Array.isArray(entries) ? entries.filter((e) => e && typeof e.hash === 'string' && Date.now() - e.at < TTL_MS) : [];
    }
    catch {
        return [];
    }
}
function save(f, entries) {
    try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(entries), 'utf8');
    }
    catch {
        // best effort
    }
}
// Called by PreToolUse for every spawn call, with the text each new
// sub-agent was handed.
function recordSubAgentPrompts(sessionId, prompts, dataDir) {
    const f = file(sessionId, dataDir);
    const fresh = prompts.map((p) => p.trim()).filter(Boolean);
    if (!f || fresh.length === 0)
        return;
    save(f, [...load(f), ...fresh.map((p) => ({ hash: fingerprint(p), at: Date.now() }))]);
}
// Called by the prompt hook: true if this prompt is the instruction text of
// a sub-agent started earlier in this session (and consumes that record).
function claimSubAgentPrompt(sessionId, prompt, dataDir) {
    const f = file(sessionId, dataDir);
    if (!f || !prompt || !prompt.trim())
        return false;
    const entries = load(f);
    const hash = fingerprint(prompt);
    const i = entries.findIndex((e) => e.hash === hash);
    if (i === -1)
        return false;
    entries.splice(i, 1);
    save(f, entries);
    return true;
}
