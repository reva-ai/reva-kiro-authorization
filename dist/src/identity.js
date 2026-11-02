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
exports.resolveUserEmail = resolveUserEmail;
exports.resolveAgentContext = resolveAgentContext;
const os = __importStar(require("node:os"));
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
// Resolves the human principal's identity: the Kiro login email first (see
// deviceId.ts's readKiroAccountEmail(), which reads it from `kiro-cli
// whoami`), then OS username as a genuine last resort — no account logged
// in, or kiro-cli not on PATH. The two are not equivalent in
// trustworthiness: the first is login-derived, the second is whatever the
// local OS says, so a policy that cares about a real principal should be
// written against email-shaped ids.
function resolveUserEmail(run) {
    // The Kiro login email, and nothing else. deviceId.ts's readKiroWhoami
    // handles the caching and the stale-account recovery, so by the time this
    // returns nothing, the account genuinely could not be established.
    const kiroEmail = (0, deviceId_1.readKiroAccountEmail)(run);
    if (kiroEmail)
        return kiroEmail;
    // Last resort: the OS username. NOT equivalent to the above and must not
    // be treated as though it were — it is not an email, it is almost
    // certainly not a provisioned Reva `User`, and sending it as the
    // principal means every request is evaluated against a stranger.
    // Ingestion then creates that stranger with active="false" (see
    // ingestionClient.ts), which a deployment gating on active users denies
    // regardless of how permissive the Cedar policy is — a wide-open
    // `permit(principal, action, resource)` included.
    //
    // Logged loudly rather than silently: the failure it causes (deny
    // everything, for a reason that looks nothing like an identity problem)
    // is extremely hard to trace back to here. In the decision log this
    // fallback shows up as a principal that is merely a local OS username.
    let username = 'unknown-user';
    try {
        username = os.userInfo().username;
    }
    catch {
        // keep the placeholder
    }
    (0, debug_1.debugLog)(`WARNING: principal fell back to the OS username "${username}" — \`kiro-cli whoami\` could not ` +
        'establish a Kiro account and no previously-resolved one was cached. This is almost certainly ' +
        'NOT a provisioned Reva User, so expect denials even under a permissive policy. ' +
        'Run `kiro-cli login`, then `npm run install-hooks` to re-warm the account cache.');
    return username;
}
// CONFIRMED ABSENT on BOTH Kiro hosts: the IDE's payload
// builder emits no agent_id/agent_type, and no captured kiro-cli payload
// carries one either. So this always resolves isSubAgent: false today.
//
// Worth knowing for when that changes: kiro-cli does have real delegation
// tools (`use_subagent`, `delegate`, and `session` with
// command="spawn_session"), and mapping.ts already maps them to the `spawn`
// action — so the spawn side is governed, it's just that the spawned
// agent's own subsequent calls are not currently distinguishable from the
// parent's. Kept as the original shape so a host version that adds the
// marker under these names starts working with no change here.
// Accepts either a normalized input (subAgentId/subAgentType, what the
// entrypoints pass) or a raw host payload (agent_id/agent_type, what the
// tests and any direct caller pass) — the two spellings of the same absent
// signal, so there's no reason to make callers convert.
function resolveAgentContext(configuredAgentId, hookInput) {
    const subAgentId = hookInput.subAgentId ?? hookInput.agent_id;
    const subAgentType = hookInput.subAgentType ?? hookInput.agent_type;
    return {
        agentId: configuredAgentId,
        isSubAgent: Boolean(subAgentId),
        subAgentId,
        subAgentType,
    };
}
