import { ActiveSession } from './activeSessions';
import { buildInvokeAgentContext, buildTransmission } from './context';
import { buildEntityDescriptor, directSpecOf } from './entity';
import { CedarRequest, DirectEvalSession } from './types';

// Canonical direct-AI invokeAgent envelope (User → Agent), used by the
// per-turn UserPromptSubmit gate.
export function buildInvokeAgentRequest(
  userEmail: string,
  agentId: string,
  prompt: string,
  session: DirectEvalSession,
  activeSessionCount = 0,
  currentSession?: ActiveSession,
  // Kiro's model for this session, and the gate that decides whether it may
  // be sent at all — see context.ts. Both optional: Kiro does not put the
  // model on the wire, so an absent one is the normal case.
  model?: string,
  modelContext = false,
  // This machine's id, sent as context.machineId — see context.ts.
  machineId?: string,
): CedarRequest {
  // User's schema-declared SCIM attributes have no trustworthy source in
  // this hook, so send a bare direct spec and let PDP resolve the provisioned
  // entity by type/id rather than fabricating request properties.
  const userDescriptor = buildEntityDescriptor('User', userEmail);
  // User/Agent identities are deliberately bare. The PDP resolves their
  // authoritative attributes from its entity store; principal already carries
  // the human relationship for this evaluation.
  const agentDescriptor = buildEntityDescriptor('Agent', agentId);
  return {
    // subject = principal here: the human IS the one directly invoking —
    // there's no intermediate acting entity yet.
    subject: directSpecOf(userDescriptor),
    principal: directSpecOf(userDescriptor),
    action: { name: 'invokeAgent' },
    resource: directSpecOf(agentDescriptor),
    context: buildInvokeAgentContext(activeSessionCount, currentSession, model, modelContext, machineId),
    transmission: buildTransmission(prompt, 'user'),
    session,
  };
}
