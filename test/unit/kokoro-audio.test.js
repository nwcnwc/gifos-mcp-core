// q8 Kokoro on an AVX-512 CPU has returned NaN and peaks like 1.5e15.
// A waveform that can be played stays inside -1..1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kokoroAudioCorrupt, kokoroClamp } from '../../src/voice/kokoro.js';

test('Kokoro audio is corrupt when a sample is NaN or is garbage', () => {
  assert.equal(kokoroAudioCorrupt(new Float32Array([0, 0.25, -1, 1])), false);
  assert.equal(kokoroAudioCorrupt(new Float32Array([0, NaN, 0.1])), true);
  assert.equal(kokoroAudioCorrupt(new Float32Array([1.5e15])), true);
  assert.equal(kokoroAudioCorrupt(new Float32Array([0, Infinity])), true);
  assert.equal(kokoroAudioCorrupt(new Float32Array([-40])), true);
  assert.equal(kokoroAudioCorrupt(null), true);
});

test('a sentence peaking past 1 (q8 1.21, fp32 1.04) plays once clamped', () => {
  const hot = new Float32Array([0, 1.21, -1.04, 0.5]);
  assert.equal(kokoroAudioCorrupt(hot), false);
  kokoroClamp(hot);
  assert.deepEqual(Array.from(hot), [0, 1, -1, 0.5]);
});
