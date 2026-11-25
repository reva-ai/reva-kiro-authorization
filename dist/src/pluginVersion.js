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
exports.ERROR_TYPE_PLUGIN_VERSION_REQUIRED = exports.ERROR_TYPE_PLUGIN_VERSION_INVALID = exports.ERROR_TYPE_PLUGIN_VERSION_UNSUPPORTED = exports.PLUGIN_VERSION_PATH = exports.PLUGIN_VERSION = void 0;
exports.isPluginVersionErrorType = isPluginVersionErrorType;
exports.unsupportedPluginVersionReason = unsupportedPluginVersionReason;
exports.invalidPluginVersionReason = invalidPluginVersionReason;
exports.isPluginVersionSupported = isPluginVersionSupported;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// Plugin PROTOCOL version — same as the Kiro marketplace plugin version
// (plugin.json), falling back to package.json.
function loadPluginVersion() {
    const candidates = [
        path.join(__dirname, '..', '..', 'plugin.json'), // dist/src → package root
        path.join(__dirname, '..', 'plugin.json'), // src → package root
        path.join(__dirname, '..', '..', 'package.json'),
        path.join(__dirname, '..', 'package.json'),
    ];
    for (const file of candidates) {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            const version = typeof raw?.version === 'string' ? raw.version.trim() : '';
            if (version)
                return version.replace(/^v/i, '');
        }
        catch {
            // try next
        }
    }
    return '1.0.0';
}
exports.PLUGIN_VERSION = loadPluginVersion();
exports.PLUGIN_VERSION_PATH = '/pdp/ai/access/v1/ai/plugin/version';
exports.ERROR_TYPE_PLUGIN_VERSION_UNSUPPORTED = 'PLUGIN_VERSION_UNSUPPORTED';
exports.ERROR_TYPE_PLUGIN_VERSION_INVALID = 'PLUGIN_VERSION_INVALID';
exports.ERROR_TYPE_PLUGIN_VERSION_REQUIRED = 'PLUGIN_VERSION_REQUIRED';
function isPluginVersionErrorType(errorType) {
    return (errorType === exports.ERROR_TYPE_PLUGIN_VERSION_UNSUPPORTED ||
        errorType === exports.ERROR_TYPE_PLUGIN_VERSION_INVALID ||
        errorType === exports.ERROR_TYPE_PLUGIN_VERSION_REQUIRED);
}
function unsupportedPluginVersionReason(pluginVersion, window) {
    if (window?.minimumSupportedVersion) {
        return (`Your current version ${pluginVersion} is outdated. ` +
            `Please update it to at least the minimum supported version ${window.minimumSupportedVersion}.`);
    }
    return `Your current version ${pluginVersion} is outdated. Please update the plugin.`;
}
function invalidPluginVersionReason() {
    return 'Reva Security plugin version is invalid. Reinstall or update the plugin.';
}
function parseSemver(raw) {
    const value = raw.trim().replace(/^[vV]/, '');
    const parts = value.split('.');
    if (parts.length !== 3)
        return undefined;
    const nums = [];
    for (const part of parts) {
        if (!part || (part.length > 1 && part.startsWith('0')) || !/^\d+$/.test(part))
            return undefined;
        nums.push(Number(part));
    }
    return { major: nums[0], minor: nums[1], patch: nums[2] };
}
function compareSemver(a, b) {
    if (a.major !== b.major)
        return a.major - b.major;
    if (a.minor !== b.minor)
        return a.minor - b.minor;
    return a.patch - b.patch;
}
/** Returns true when pluginVersion is inside [minimum supported version, current]. */
function isPluginVersionSupported(pluginVersion, window) {
    const plugin = parseSemver(pluginVersion);
    const msp = parseSemver(window.minimumSupportedVersion);
    const current = parseSemver(window.currentVersion);
    if (!plugin || !msp || !current)
        return false;
    if (compareSemver(plugin, msp) < 0 || compareSemver(plugin, current) > 0)
        return false;
    if (plugin.major < msp.major || plugin.major > current.major)
        return false;
    return true;
}
