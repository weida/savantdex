import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortKeysDeep, canonicalJson, computeResultHash } from '../sdk/canonical.mjs'

test('sortKeysDeep: primitive pass-through', () => {
  assert.equal(sortKeysDeep(42), 42)
  assert.equal(sortKeysDeep('x'), 'x')
  assert.equal(sortKeysDeep(null), null)
  assert.equal(sortKeysDeep(true), true)
})

test('sortKeysDeep: flat object keys sorted', () => {
  const out = sortKeysDeep({ b: 1, a: 2, c: 3 })
  assert.deepEqual(Object.keys(out), ['a', 'b', 'c'])
})

test('sortKeysDeep: nested object keys sorted recursively', () => {
  const out = sortKeysDeep({ z: { y: 1, x: 2 }, a: 0 })
  assert.deepEqual(Object.keys(out), ['a', 'z'])
  assert.deepEqual(Object.keys(out.z), ['x', 'y'])
})

test('sortKeysDeep: array elements sorted internally (not reordered)', () => {
  const out = sortKeysDeep([{ b: 1, a: 2 }, { d: 3, c: 4 }])
  assert.deepEqual(Object.keys(out[0]), ['a', 'b'])
  assert.deepEqual(Object.keys(out[1]), ['c', 'd'])
})

test('canonicalJson: deterministic regardless of input key order', () => {
  const a = canonicalJson({ b: 1, a: 2 })
  const b = canonicalJson({ a: 2, b: 1 })
  assert.equal(a, b)
  assert.equal(a, '{"a":2,"b":1}')
})

test('computeResultHash: stable over key reordering', () => {
  const h1 = computeResultHash({ x: 1, y: 2 })
  const h2 = computeResultHash({ y: 2, x: 1 })
  assert.equal(h1, h2)
  assert.equal(h1.length, 64)
})

test('computeResultHash: differs on value change', () => {
  assert.notEqual(computeResultHash({ x: 1 }), computeResultHash({ x: 2 }))
})
