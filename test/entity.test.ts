import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEntityDescriptor, directSpecOf, entityRef, refOf } from '../src/entity';

test('buildEntityDescriptor builds a full entity: uid, attrs, parents', () => {
  const d = buildEntityDescriptor('Agent', 'aa-bb-cc-dd-ee-ff', { user: { __entity: { type: 'User', id: 'alice@example.com' } } }, [
    { type: 'Org', id: 'reva' },
  ]);
  assert.deepEqual(d.uid, { type: 'Agent', id: 'aa-bb-cc-dd-ee-ff' });
  assert.deepEqual(d.attrs, { user: { __entity: { type: 'User', id: 'alice@example.com' } } });
  assert.deepEqual(d.parents, [{ type: 'Org', id: 'reva' }]);
});

test('buildEntityDescriptor defaults attrs to {} and parents to [] when omitted', () => {
  const d = buildEntityDescriptor('User', 'alice@example.com');
  assert.deepEqual(d.attrs, {});
  assert.deepEqual(d.parents, []);
});

test('refOf extracts a bare {type, id} pointer from a descriptor', () => {
  const d = buildEntityDescriptor('Agent', 'aa-bb-cc-dd-ee-ff');
  assert.deepEqual(refOf(d), { type: 'Agent', id: 'aa-bb-cc-dd-ee-ff' });
});

test('entityRef builds a bare {type, id} pointer directly', () => {
  assert.deepEqual(entityRef('User', 'alice@example.com'), { type: 'User', id: 'alice@example.com' });
});

test('directSpecOf maps attrs and request-local parents without a legacy uid shape', () => {
  const descriptor = buildEntityDescriptor('File', 'repo/a.ts', { name: 'a.ts' }, [
    { type: 'Repository', id: 'repo' },
  ]);
  const spec = directSpecOf(descriptor);
  assert.deepEqual(spec, {
    type: 'File',
    id: 'repo/a.ts',
    properties: { name: 'a.ts' },
    parents: [{ type: 'Repository', id: 'repo' }],
  });
  assert.equal('uid' in spec, false);
});
