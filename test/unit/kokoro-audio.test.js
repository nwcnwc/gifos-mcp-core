// q8 Kokoro on an AVX-512 CPU has returned NaN and peaks like 1.5e15.
// A waveform that can be played stays inside -1..1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kokoroAudioCorrupt } from '../../src/voice/kokoro.js';

test('Kokoro audio is corrupt when a sample is NaN or outside -1..1', () => {
  assert.equal(kokoroAudioCorrupt(new Float32Array([0, 0.25, -1, 1])), false);
  assert.equal(kokoroAudioCorrupt(new Float32Array([0, NaN, 0.1])), true);
  assert.equal(kokoroAudioCorrupt(new Float32Array([1.5e15])), true);
  assert.equal(kokoroAudioCorrupt(new Float32Array([0, Infinity])), true);
  assert.equal(kokoroAudioCorrupt(new Float32Array([-1.01])), true);
  assert.equal(kokoroAudioCorrupt(null), true);
});
