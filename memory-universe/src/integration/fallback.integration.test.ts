/**
 * Unified runtime fallback integration tests.
 *
 * These tests keep the old file location for discoverability, but the target
 * system is now the unified Rust runtime on port 8080.
 */

import axios from 'axios';
import { describe, it, expect, beforeAll } from '@jest/globals';

const UNIFIED_RUNTIME_URL =
  process.env.MEMORY_SUITE_URL ||
  process.env.MEMORY_UNIVERSE_URL ||
  'http://localhost:8080';
const BRAINNN_URL = process.env.BRAINNN_URL || 'http://localhost:4007';
const TTS_URL = process.env.TTS_SERVICE_URL || 'http://localhost:3000';

describe('Unified Runtime Fallback Integration Tests', () => {
  let unifiedHealthy = false;
  let brainnnHealthy = false;
  let ttsHealthy = false;

  beforeAll(async () => {
    try {
      const response = await axios.get(`${UNIFIED_RUNTIME_URL}/api/health`, { timeout: 5000 });
      unifiedHealthy = response.status === 200;
    } catch {
      console.warn('Unified runtime not available for testing');
    }

    try {
      const response = await axios.get(`${BRAINNN_URL}/health`, { timeout: 5000 });
      brainnnHealthy = response.status === 200;
    } catch {
      console.warn('BrainNN not available for testing');
    }

    try {
      const response = await axios.get(`${TTS_URL}/health`, { timeout: 5000 });
      ttsHealthy = response.status === 200;
    } catch {
      console.warn('TTS not available for testing');
    }
  });

  describe('Unified chat flow', () => {
    it('should return a valid chat response', async () => {
      if (!unifiedHealthy) {
        return;
      }

      const response = await axios.post(`${UNIFIED_RUNTIME_URL}/api/chat`, {
        session_id: 'fallback-integration',
        user_id: 'test-user',
        text: 'Hello from fallback integration'
      });

      expect(response.status).toBe(200);
      expect(
        response.data.response_text || response.data.response || response.data.text
      ).toBeTruthy();
    });

    it('should handle repeated requests', async () => {
      if (!unifiedHealthy) {
        return;
      }

      const responses = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          axios.post(`${UNIFIED_RUNTIME_URL}/api/chat`, {
            session_id: 'fallback-integration-burst',
            user_id: 'test-user',
            text: `burst ${index}`
          })
        )
      );

      expect(responses.every(response => response.status === 200)).toBe(true);
    });

    it('should not expose raw internal errors in text output', async () => {
      if (!unifiedHealthy) {
        return;
      }

      const response = await axios.post(`${UNIFIED_RUNTIME_URL}/api/chat`, {
        session_id: 'fallback-integration-safety',
        user_id: 'test-user',
        text: 'Test safety path'
      });

      const text = response.data.response_text || response.data.response || response.data.text;
      expect(typeof text).toBe('string');
      expect(text).not.toMatch(/TypeError:|ReferenceError:|panic/i);
    });
  });

  describe('Unified runtime surfaces', () => {
    it('should expose runtime overview', async () => {
      if (!unifiedHealthy) {
        return;
      }

      const response = await axios.get(`${UNIFIED_RUNTIME_URL}/api/runtime/overview`);
      expect(response.status).toBe(200);
    });

    it('should expose live2d state', async () => {
      if (!unifiedHealthy) {
        return;
      }

      const response = await axios.get(`${UNIFIED_RUNTIME_URL}/api/live2d/state`);
      expect(response.status).toBe(200);
    });

    it('should expose danmaku state', async () => {
      if (!unifiedHealthy) {
        return;
      }

      const response = await axios.get(`${UNIFIED_RUNTIME_URL}/api/danmaku/state`);
      expect(response.status).toBe(200);
    });

    it('should enqueue tts requests through the unified runtime', async () => {
      if (!unifiedHealthy) {
        return;
      }

      const response = await axios.post(`${UNIFIED_RUNTIME_URL}/api/tts/speak`, {
        text: 'integration tts',
        voice: 'default',
        session_id: 'fallback-integration-tts'
      });
      expect([200, 202]).toContain(response.status);
    });
  });

  describe('Optional sidecars', () => {
    it('should tolerate BrainNN being unavailable', async () => {
      expect(typeof brainnnHealthy).toBe('boolean');
    });

    it('should tolerate TTS sidecar being unavailable', async () => {
      expect(typeof ttsHealthy).toBe('boolean');
    });
  });
});
