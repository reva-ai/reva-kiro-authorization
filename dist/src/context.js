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
exports.truncatePrompt = truncatePrompt;
exports.osAttribute = osAttribute;
exports.buildActionContext = buildActionContext;
exports.buildInvokeAgentContext = buildInvokeAgentContext;
exports.buildTransmission = buildTransmission;
exports.serializeToolResponse = serializeToolResponse;
exports.buildToolResponseTransmission = buildToolResponseTransmission;
const nodeOs = __importStar(require("node:os"));
const ingestionClient_1 = require("./ingestionClient");
// Sent as the invokeAgent userQuery. A PDP 413 fails open for that request,
// so raise this only after confirming the PDP accepts the resulting request
// size. The prompt is sent to Reva and not stored on this machine.
const MAX_PROMPT_LENGTH = 10000;
function truncatePrompt(prompt) {
    return prompt.length > MAX_PROMPT_LENGTH ? `${prompt.slice(0, MAX_PROMPT_LENGTH)}…` : prompt;
}
// Exported with an injectable platform so tests can cover every value
// without mocking node:os.
function osAttribute(platform = nodeOs.platform()) {
    if (platform === 'win32')
        return 'Windows';
    if (platform === 'darwin')
        return 'macOS';
    return 'Linux';
}
function activeSessionFields(extras) {
    return {
        activeSessionCount: extras.activeSessionCount ?? 0,
        sessionId: extras.currentSession?.sessionId ?? '',
        sessionEntryPoint: extras.currentSession?.entrypoint ?? '',
        sessionLastSeen: extras.currentSession?.lastSeen ?? 0,
        agentType: ingestionClient_1.AGENT_TYPE,
        machineId: extras.machineId ?? '',
        os: osAttribute(),
        ...(extras.model ? { model: extras.model } : {}),
    };
}
function buildActionContext(mapping, extras = {}) {
    const timestamp = Date.now();
    const sessions = activeSessionFields(extras);
    switch (mapping.actionName) {
        case 'invokeTool':
            return { timestamp, ...sessions };
        case 'spawn':
            return { timestamp, subagentIndex: extras.subagentIndex ?? 1, ...sessions };
        case 'executeBash':
            return { timestamp, command: mapping.command ?? '', ...sessions };
        case 'read':
        case 'write':
        case 'edit':
        case 'glob':
        case 'grep':
            return { timestamp, ...sessions };
        default:
            return { timestamp, ...sessions };
    }
}
function buildInvokeAgentContext(activeSessionCount = 0, currentSession, model, machineId) {
    return {
        timestamp: Date.now(),
        ...activeSessionFields({ activeSessionCount, currentSession, model, machineId }),
    };
}
// `role`/`contentType`/`promptKey` are constants here — the hook payload has
// no multi-role or multi-content-type concept, only ever the current turn's
// plain-text prompt.
function buildTransmission(content, role, nonblankFallback) {
    const userQuery = content.trim() ? content : (nonblankFallback || '').trim();
    if (!userQuery) {
        throw new Error('direct AI evaluation requires a nonblank current prompt');
    }
    return { promptKey: 'userQuery', userQuery, role, contentType: 'text/plain' };
}
// Sent once, as transmission.response on that tool call's PostToolUse
// request.
const MAX_TOOL_RESPONSE_LENGTH = 10000;
function serializeToolResponse(toolResponse) {
    if (toolResponse == null)
        return '';
    const raw = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
    return raw.length > MAX_TOOL_RESPONSE_LENGTH ? `${raw.slice(0, MAX_TOOL_RESPONSE_LENGTH)}…` : raw;
}
// PostToolUse: userQuery is the SAME current-call prompt PreToolUse sent, so
// the pre/post pair of one call shows one prompt, and the tool's result rides
// separately in transmission.response. context no longer carries a `prompt`
// field at all — that's now PDP-managed, not client-set.
function buildToolResponseTransmission(toolResponse, userQuery) {
    const transmission = buildTransmission(userQuery, 'tool');
    transmission.response = serializeToolResponse(toolResponse);
    return transmission;
}
