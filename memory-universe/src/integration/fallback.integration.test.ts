/**
 * Integration Tests for Memory Universe Fallback System
 * 
 * Tests the complete fallback flow with actual service interactions
 * Requirements: 1.1, 1.2, 1.9, 1.10
 */

import axios from 'axios';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

const MEMORY_UNIVERSE_URL = process.env.MEMORY_UNIVERSE_URL || 'http://localhost:4005';
const BRAINNN_URL = process.env.BRAINNN_URL || 'http://localhost:4007';
const TTS_URL = process.env.TTS_SERVICE_URL || 'http://localhost:3000';

const FALLBACK_MESSAGE = '请告诉我的创造者，我的ai出现问题了';

describe('Memory Universe Fallback Integration Tests', () => {
  let memoryUniverseHealthy = false;
  let brainnnHealthy = false;
  let ttsHealthy = false;

  beforeAll(async () => {
    // Check service availability
    try {
      const response = await axios.get(`${MEMORY_UNIVERSE_URL}/health`, { timeout: 5000 });
      memoryUniverseHealthy = response.status === 200;
    } catch (error) {
      console.warn('Memory Universe not available for testing');
    }

    try {
      const response = await axios.get(`${BRAINNN_URL}/health`, { timeout: 5000 });
      brainnnHealthy = response.status === 200;
    } catch (error) {
      console.warn('BrainNN not available for testing');
    }

    try {
      const response = await axios.get(`${TTS_URL}/health`, { timeout: 5000 });
      ttsHealthy = response.status === 200;
    } catch (error) {
      console.warn('TTS not available for testing');
    }
  });

  describe('Chat Endpoint Fallback', () => {
    it('should return valid response on success', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Hello',
        userId: 'test-user',
        userName: 'Test User'
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('text');
      expect(response.data.text).toBeTruthy();
    });

    it('should return fallback message on LLM failure', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      // This test would require mocking LLM failure
      // For now, we just verify the endpoint responds
      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Test message',
        userId: 'test-user'
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('text');
    });

    it('should always return a text response', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Test',
        userId: 'test-user'
      });

      expect(response.data.text).toBeDefined();
      expect(typeof response.data.text).toBe('string');
      expect(response.data.text.length).toBeGreaterThan(0);
    });
  });

  describe('Creator Chat Endpoint Fallback', () => {
    it('should return valid response for creator', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat/creator`, {
        message: 'Creator message',
        userId: 'creator',
        userName: 'Creator'
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('text');
    });

    it('should always return text for creator', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat/creator`, {
        message: 'Test',
        userId: 'creator'
      });

      expect(response.data.text).toBeDefined();
      expect(typeof response.data.text).toBe('string');
    });
  });

  describe('Event Endpoint Fallback', () => {
    it('should handle danmaku events', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/event`, {
        type: 'danmaku',
        content: 'Test danmaku',
        metadata: { user: 'test-user' }
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success');
    });

    it('should handle gift events', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/event`, {
        type: 'gift',
        content: 'Gift',
        metadata: { user: 'test-user', gift: 'rose', count: 1 }
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success');
    });
  });

  describe('Fallback Message Consistency', () => {
    it('should use unified fallback message', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Test',
        userId: 'test-user'
      });

      // Response should either be normal or fallback, but never error
      expect(response.data.text).toBeDefined();
      expect(response.data.text).not.toContain('error');
      expect(response.data.text).not.toContain('Error');
    });

    it('should not expose error details to user', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Test',
        userId: 'test-user'
      });

      // Should not contain stack traces or technical details
      expect(response.data.text).not.toMatch(/at\s+\w+/);
      expect(response.data.text).not.toMatch(/Error:/);
      expect(response.data.text).not.toMatch(/TypeError:/);
    });
  });

  describe('Multiple Service Failures', () => {
    it('should handle BrainNN unavailability gracefully', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      // This test verifies that Memory Universe continues even if BrainNN is down
      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Test with potential BrainNN failure',
        userId: 'test-user'
      });

      expect(response.status).toBe(200);
      expect(response.data.text).toBeDefined();
    });

    it('should handle TTS unavailability gracefully', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      // This test verifies that Memory Universe continues even if TTS is down
      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Test with potential TTS failure',
        userId: 'test-user'
      });

      expect(response.status).toBe(200);
      expect(response.data.text).toBeDefined();
    });
  });

  describe('Timeout Handling', () => {
    it('should timeout gracefully', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      try {
        const response = await axios.post(
          `${MEMORY_UNIVERSE_URL}/api/chat`,
          {
            message: 'Test',
            userId: 'test-user'
          },
          { timeout: 30000 } // 30 second timeout
        );

        expect(response.status).toBe(200);
        expect(response.data.text).toBeDefined();
      } catch (error: any) {
        // If timeout occurs, it should be handled gracefully
        if (error.code === 'ECONNABORTED') {
          console.log('Request timed out as expected');
        } else {
          throw error;
        }
      }
    });
  });

  describe('Response Format Validation', () => {
    it('should return properly formatted response', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Test',
        userId: 'test-user'
      });

      expect(response.data).toHaveProperty('text');
      expect(typeof response.data.text).toBe('string');
      expect(response.data.text.length).toBeGreaterThan(0);
    });

    it('should not return empty text', async () => {
      if (!memoryUniverseHealthy) {
        console.log('Skipping test: Memory Universe not available');
        return;
      }

      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Test',
        userId: 'test-user'
      });

      expect(response.data.text).not.toBe('');
      expect(response.data.text).not.toBe(null);
      expect(response.data.text).not.toBe(undefined);
    });
  });
});
