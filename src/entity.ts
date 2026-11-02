import { CedarEntityDescriptor, CedarEntityRef, DirectEvalEntitySpec } from './types';

// Builds the plugin's internal normalized entity description. The mapping
// layer can retain attrs/ancestry here even though directSpecOf deliberately
// emits no classic request-level entity graph.
export function buildEntityDescriptor(
  type: string,
  id: string,
  attrs: Record<string, any> = {},
  parents: CedarEntityRef[] = [],
): CedarEntityDescriptor {
  return {
    uid: { type, id },
    attrs,
    parents,
  };
}

// The bare {type, id} pointer used in active-turn hops.
export function refOf(descriptor: CedarEntityDescriptor): CedarEntityRef {
  return { type: descriptor.uid.type, id: descriptor.uid.id };
}

// Converts the plugin's internal descriptor into the direct-AI endpoint's
// entity shape. PDP resolves bare stored identities authoritatively, while
// optional properties/parents preserve ephemeral coding resources that exist
// only for the lifetime of a hook request.
export function directSpecOf(descriptor: CedarEntityDescriptor): DirectEvalEntitySpec {
  const properties = descriptor.attrs;
  return {
    type: descriptor.uid.type,
    id: descriptor.uid.id,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(descriptor.parents.length > 0 ? { parents: descriptor.parents } : {}),
  };
}

export function entityRef(type: string, id: string): CedarEntityRef {
  return { type, id };
}
