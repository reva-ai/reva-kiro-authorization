import * as os from 'node:os';
import { debugLog } from './debug';
import { readKiroAccountEmail } from './deviceId';

// Resolves the human principal's identity: the Kiro login email first (see
// deviceId.ts's readKiroAccountEmail(), which reads it from `kiro-cli
// whoami`), then OS username as a genuine last resort — no account logged
// in, or kiro-cli not on PATH. The two are not equivalent in
// trustworthiness: the first is login-derived, the second is whatever the
// local OS says, so a policy that cares about a real principal should be
// written against email-shaped ids.
export function resolveUserEmail(run?: () => string): string {
  // The Kiro login email, and nothing else. deviceId.ts's readKiroWhoami
  // handles the caching and the stale-account recovery, so by the time this
  // returns nothing, the account genuinely could not be established.
  const kiroEmail = readKiroAccountEmail(run);
  if (kiroEmail) return kiroEmail;

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
  } catch {
    // keep the placeholder
  }
  debugLog(
    `WARNING: principal fell back to the OS username "${username}" — \`kiro-cli whoami\` could not ` +
      'establish a Kiro account and no previously-resolved one was cached. This is almost certainly ' +
      'NOT a provisioned Reva User, so expect denials even under a permissive policy. ' +
      'Run `kiro-cli login`, then `npm run install-hooks` to re-warm the account cache.',
  );
  return username;
}

// "AgentContext" here means "the calling entity's context" (main session vs
// subagent) — a naming coincidence with the Cedar `Agent` entity type, not
// a reference to it; don't conflate the two.
export interface AgentContext {
  agentId: string;
  isSubAgent: boolean;
  subAgentId?: string;
  subAgentType?: string;
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
export function resolveAgentContext(
  configuredAgentId: string,
  hookInput: { agent_id?: string; agent_type?: string; subAgentId?: string; subAgentType?: string },
): AgentContext {
  const subAgentId = hookInput.subAgentId ?? hookInput.agent_id;
  const subAgentType = hookInput.subAgentType ?? hookInput.agent_type;
  return {
    agentId: configuredAgentId,
    isSubAgent: Boolean(subAgentId),
    subAgentId,
    subAgentType,
  };
}
