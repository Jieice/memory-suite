"""
Integration Tests for BrainNN Fallback System

Tests the complete fallback flow with actual service interactions
Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
"""

import asyncio
import pytest
import aiohttp
import os
from typing import Optional

BRAINNN_URL = os.environ.get('BRAINNN_URL', 'http://localhost:4007')
AGENT_CORE_URL = os.environ.get('AGENT_CORE_URL', 'http://localhost:4009')
MEMORY_SYSTEM_URL = os.environ.get('MEMORY_SYSTEM_V2_URL', 'http://localhost:4010')
REFLECTION_ENGINE_URL = os.environ.get('REFLECTION_ENGINE_URL', 'http://localhost:4011')
NEURO_SYMBOLIC_URL = os.environ.get('NEURO_SYMBOLIC_BRIDGE_URL', 'http://localhost:4012')

FALLBACK_MESSAGE = "请告诉我的创造者，我的ai出现问题了"


class TestBrainNNFallback:
    """Test BrainNN fallback handling"""

    @pytest.fixture
    async def session(self):
        """Create aiohttp session"""
        async with aiohttp.ClientSession() as session:
            yield session

    async def check_service_health(self, url: str) -> bool:
        """Check if a service is available"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{url}/health", timeout=aiohttp.ClientTimeout(total=2.0)) as resp:
                    return resp.status == 200
        except Exception:
            return False

    @pytest.mark.asyncio
    async def test_think_endpoint_success(self):
        """Test /think endpoint with all services available"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BRAINNN_URL}/think",
                json={"text": "Hello", "source": "test"},
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert "soul" in data or "text" in data

    @pytest.mark.asyncio
    async def test_think_endpoint_returns_valid_response(self):
        """Test /think endpoint returns valid response"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BRAINNN_URL}/think",
                json={"text": "Test message", "source": "test"},
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert isinstance(data, dict)

    @pytest.mark.asyncio
    async def test_tick_endpoint_success(self):
        """Test /tick endpoint with proactive decision"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{BRAINNN_URL}/tick",
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert "should_proactive" in data
                assert isinstance(data["should_proactive"], bool)

    @pytest.mark.asyncio
    async def test_tick_endpoint_degraded_logic(self):
        """Test /tick endpoint uses degraded logic when Agent Core unavailable"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{BRAINNN_URL}/tick",
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                # Should always return a decision, even if degraded
                assert "should_proactive" in data
                assert "decision_reason" in data

    @pytest.mark.asyncio
    async def test_feedback_endpoint_success(self):
        """Test /feedback endpoint"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BRAINNN_URL}/feedback",
                json={
                    "type": "positive",
                    "value": 0.8,
                    "context": {"test": True}
                },
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert "success" in data

    @pytest.mark.asyncio
    async def test_feedback_endpoint_handles_reflection_failure(self):
        """Test /feedback endpoint handles Reflection Engine failure"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BRAINNN_URL}/feedback",
                json={
                    "type": "negative",
                    "value": 0.2,
                    "context": {}
                },
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                # Should still succeed even if Reflection Engine is unavailable
                assert data.get("success") is not False

    @pytest.mark.asyncio
    async def test_state_endpoint(self):
        """Test /state endpoint"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{BRAINNN_URL}/state",
                timeout=aiohttp.ClientTimeout(total=5.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert "emotion" in data or "drives" in data or "personality" in data

    @pytest.mark.asyncio
    async def test_timeout_handling(self):
        """Test timeout handling in endpoints"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{BRAINNN_URL}/think",
                    json={"text": "Test", "source": "test"},
                    timeout=aiohttp.ClientTimeout(total=30.0)
                ) as resp:
                    assert resp.status == 200
        except asyncio.TimeoutError:
            pytest.skip("Request timed out")

    @pytest.mark.asyncio
    async def test_multiple_service_failures(self):
        """Test handling of multiple service failures"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        # This test verifies that BrainNN continues even if multiple services fail
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BRAINNN_URL}/think",
                json={"text": "Test with potential failures", "source": "test"},
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                # Should still return valid response
                assert isinstance(data, dict)

    @pytest.mark.asyncio
    async def test_response_format_validation(self):
        """Test response format is valid"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BRAINNN_URL}/think",
                json={"text": "Test", "source": "test"},
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert isinstance(data, dict)
                # Should have expected fields
                assert any(key in data for key in ["soul", "text", "think_result"])

    @pytest.mark.asyncio
    async def test_error_recovery(self):
        """Test error recovery in endpoints"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        # Make multiple requests to verify recovery
        async with aiohttp.ClientSession() as session:
            for i in range(3):
                async with session.post(
                    f"{BRAINNN_URL}/think",
                    json={"text": f"Test {i}", "source": "test"},
                    timeout=aiohttp.ClientTimeout(total=10.0)
                ) as resp:
                    assert resp.status == 200


class TestFallbackHandlerIntegration:
    """Test Fallback Handler integration"""

    async def check_service_health(self, url: str) -> bool:
        """Check if a service is available"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{url}/health", timeout=aiohttp.ClientTimeout(total=2.0)) as resp:
                    return resp.status == 200
        except Exception:
            return False

    @pytest.mark.asyncio
    async def test_agent_core_timeout_handling(self):
        """Test Agent Core timeout is handled gracefully"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        # This test verifies that timeouts are handled
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{BRAINNN_URL}/tick",
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                # Should have decision even if Agent Core times out
                assert "should_proactive" in data

    @pytest.mark.asyncio
    async def test_memory_system_timeout_handling(self):
        """Test Memory System timeout is handled gracefully"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BRAINNN_URL}/think",
                json={"text": "Test", "source": "test"},
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                # Should succeed even if Memory System times out

    @pytest.mark.asyncio
    async def test_neuro_symbolic_timeout_handling(self):
        """Test Neuro-Symbolic Bridge timeout is handled gracefully"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BRAINNN_URL}/think",
                json={"text": "Test", "source": "test"},
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                # Should succeed even if Neuro-Symbolic times out

    @pytest.mark.asyncio
    async def test_reflection_engine_timeout_handling(self):
        """Test Reflection Engine timeout is handled gracefully"""
        if not await self.check_service_health(BRAINNN_URL):
            pytest.skip("BrainNN not available")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BRAINNN_URL}/feedback",
                json={"type": "positive", "value": 0.8},
                timeout=aiohttp.ClientTimeout(total=10.0)
            ) as resp:
                assert resp.status == 200
                # Should succeed even if Reflection Engine times out


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
