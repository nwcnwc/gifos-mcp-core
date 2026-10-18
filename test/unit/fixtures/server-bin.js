#!/usr/bin/env node
// The shared process with no product tools: what each server's bin runs,
// for tests of start-up (Kokoro, config) that need a real process.
import { runMain } from '../../../src/main.js';

await runMain({ name: 'gifos-mcp-core-test', version: '0.0.0', httpPort: 19599, register: () => {} });
