"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEntityDescriptor = buildEntityDescriptor;
exports.refOf = refOf;
exports.directSpecOf = directSpecOf;
exports.entityRef = entityRef;
// Builds the plugin's internal normalized entity description. The mapping
// layer can retain attrs/ancestry here even though directSpecOf deliberately
// emits no classic request-level entity graph.
function buildEntityDescriptor(type, id, attrs = {}, parents = []) {
    return {
        uid: { type, id },
        attrs,
        parents,
    };
}
// The bare {type, id} pointer used in active-turn hops.
function refOf(descriptor) {
    return { type: descriptor.uid.type, id: descriptor.uid.id };
}
// Converts the plugin's internal descriptor into the direct-AI endpoint's
// entity shape. PDP resolves bare stored identities authoritatively, while
// optional properties/parents preserve ephemeral coding resources that exist
// only for the lifetime of a hook request.
function directSpecOf(descriptor) {
    const properties = descriptor.attrs;
    return {
        type: descriptor.uid.type,
        id: descriptor.uid.id,
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
        ...(descriptor.parents.length > 0 ? { parents: descriptor.parents } : {}),
    };
}
function entityRef(type, id) {
    return { type, id };
}
