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
exports.mcpConfigPaths = mcpConfigPaths;
exports.parseMcpJson = parseMcpJson;
exports.readKiroMcpServers = readKiroMcpServers;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const kiroSettings_1 = require("./kiroSettings");
const REMOTE_TYPES = new Set(['streamable-http', 'sse', 'http']);
function mcpConfigPaths(cwd, env = process.env) {
    return [
        path.join(cwd, 'mcp.json'),
        path.join((0, kiroSettings_1.resolveKiroHome)(env), 'settings', 'mcp.json'),
        path.join(cwd, '.kiro', 'settings', 'mcp.json'),
    ];
}
function parseMcpJson(raw) {
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        return [];
    }
    const servers = data?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers))
        return [];
    const out = [];
    for (const [name, entry] of Object.entries(servers)) {
        if (!name || !entry || typeof entry !== 'object')
            continue;
        // Kiro does not load a disabled server, so it is not part of what this
        // agent can reach.
        if (entry.disabled === true)
            continue;
        const remote = typeof entry.url === 'string' && entry.url.trim() && (!entry.type || REMOTE_TYPES.has(entry.type));
        out.push(remote ? { name, url: entry.url.trim() } : { name });
    }
    return out;
}
function readKiroMcpServers(cwd, env = process.env) {
    const byName = new Map();
    for (const file of mcpConfigPaths(cwd, env)) {
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        }
        catch {
            continue;
        }
        for (const server of parseMcpJson(raw))
            byName.set(server.name, server);
    }
    return [...byName.values()];
}
