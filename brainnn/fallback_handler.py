"""
BrainNN Fallback Handler

Handles BrainNN service failures with graceful degradation.
When services are unavailable, implements degraded logic or skips processing.

Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 4.1, 4.2, 4.3, 4.4
"""

import asyncio
import aiohttp
import logging
import os
import time
from typing import Any, Dict, Optional, Tuple, Set
from datetime import datetime

FALLBACK_MESSAGE = "请告诉我的创造者，我的ai出现问题了"

def _get_timeout(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


BRAINNN_TIMEOUT = _get_timeout('BRAINNN_TIMEOUT', 1.0)
AGENT_CORE_TIMEOUT = _get_timeout('AGENT_CORE_TIMEOUT', 0.5)
MEMORY_SYSTEM_TIMEOUT = _get_timeout('MEMORY_SYSTEM_TIMEOUT', 0.5)
NEURO_SYMBOLIC_TIMEOUT = _get_timeout('NEURO_SYMBOLIC_TIMEOUT', 0.5)
REFLECTION_ENGINE_TIMEOUT = _get_timeout('REFLECTION_ENGINE_TIMEOUT', 0.5)
PREDICTION_ENGINE_TIMEOUT = _get_timeout('PREDICTION_ENGINE_TIMEOUT', 0.5)

SERVICE_UNAVAILABLE_CACHE_TTL = 60  # seconds to remember a service is down

logger = logging.getLogger(__name__)


class BrainNNFallbackHandler:
    """
    Handles fallback logic for BrainNN and dependent services
    Includes service availability caching to skip known-unavailable services
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.agent_core_url = self.config.get('agent_core_url', 'http://localhost:4008')
        self.memory_system_url = self.config.get('memory_system_url', 'http://localhost:4009')
        self.neuro_symbolic_url = self.config.get('neuro_symbolic_url', 'http://localhost:4010')
        self.reflection_engine_url = self.config.get('reflection_engine_url', 'http://localhost:4011')
        self.prediction_engine_url = self.config.get('prediction_engine_url', 'http://localhost:4012')
        
        # Cache of unavailable services: {service_name: timestamp_when_marked_unavailable}
        self._unavailable_services: Dict[str, float] = {}
        
    def _is_service_available(self, service_name: str) -> bool:
        """Check if service is known to be unavailable (cached)"""
        if service_name not in self._unavailable_services:
            return True
        # Check if cache entry has expired
        marked_time = self._unavailable_services[service_name]
        if time.time() - marked_time > SERVICE_UNAVAILABLE_CACHE_TTL:
            # Cache expired, try again
            del self._unavailable_services[service_name]
            return True
        return False
    
    def _mark_service_unavailable(self, service_name: str):
        """Mark a service as unavailable"""
        self._unavailable_services[service_name] = time.time()
        
    def _mark_service_available(self, service_name: str):
        """Mark a service as available (remove from unavailable cache)"""
        self._unavailable_services.pop(service_name, None)

    async def call_with_timeout(
        self,
        service_name: str,
        url: str,
        method: str = 'GET',
        data: Optional[Dict] = None,
        timeout: float = 2.0,
        skip_if_unavailable: bool = True
    ) -> Tuple[bool, Optional[Dict], Optional[str]]:
        """
        Call a service with timeout handling and availability caching
        
        Args:
            service_name: Name of the service
            url: URL to call
            method: HTTP method (GET, POST)
            data: Request data for POST
            timeout: Timeout in seconds
            skip_if_unavailable: If True, skip call if service is known to be down
            
        Returns:
            Tuple of (success, response_data, error_message)
        """
        # Skip if service is known to be unavailable
        if skip_if_unavailable and not self._is_service_available(service_name):
            return False, None, f"{service_name} skipped (known unavailable)"
        
        try:
            async with aiohttp.ClientSession() as session:
                try:
                    if method == 'POST':
                        async with session.post(url, json=data, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                            if resp.status == 200:
                                self._mark_service_available(service_name)
                                return True, await resp.json(), None
                            else:
                                error_msg = f"{service_name} returned status {resp.status}"
                                self._mark_service_unavailable(service_name)
                                self._log_fallback(service_name, error_msg, 'warning')
                                return False, None, error_msg
                    else:
                        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                            if resp.status == 200:
                                self._mark_service_available(service_name)
                                return True, await resp.json(), None
                            else:
                                error_msg = f"{service_name} returned status {resp.status}"
                                self._mark_service_unavailable(service_name)
                                self._log_fallback(service_name, error_msg, 'warning')
                                return False, None, error_msg
                except asyncio.TimeoutError:
                    error_msg = f"{service_name} timeout after {timeout}s"
                    self._mark_service_unavailable(service_name)
                    self._log_fallback(service_name, error_msg, 'warning')
                    return False, None, error_msg
        except aiohttp.ClientConnectorError as e:
            error_msg = f"{service_name} connection refused"
            self._mark_service_unavailable(service_name)
            self._log_fallback(service_name, error_msg, 'warning')
            return False, None, error_msg
        except aiohttp.ClientError as e:
            error_msg = f"{service_name} error: {str(e)}"
            self._mark_service_unavailable(service_name)
            self._log_fallback(service_name, error_msg, 'warning')
            return False, None, error_msg
        except Exception as e:
            error_msg = f"{service_name} unexpected error: {str(e)}"
            self._log_fallback(service_name, error_msg, 'error')
            return False, None, error_msg

    async def think(self, text: str, source: str) -> Dict[str, Any]:
        """
        Process thinking with fallback handling
        
        Calls Agent Core, Memory System, and Neuro-Symbolic Bridge in PARALLEL
        If any fail, continues with available services
        
        Args:
            text: Input text
            source: Source of input (user, creator, etc.)
            
        Returns:
            Thinking result or degraded response
        """
        result = {
            'success': True,
            'text': text,
            'source': source,
            'services_used': [],
            'services_failed': []
        }

        # Call all services in PARALLEL for faster response
        tasks = [
            self.call_with_timeout(
                'Agent Core',
                f"{self.agent_core_url}/think",
                'POST',
                {'text': text, 'source': source},
                AGENT_CORE_TIMEOUT
            ),
            self.call_with_timeout(
                'Memory System',
                f"{self.memory_system_url}/memory/store",
                'POST',
                {'content': text, 'source': source, 'type': 'episodic'},
                MEMORY_SYSTEM_TIMEOUT
            ),
            self.call_with_timeout(
                'Neuro-Symbolic Bridge',
                f"{self.neuro_symbolic_url}/check",
                'POST',
                {'text': text},
                NEURO_SYMBOLIC_TIMEOUT
            ),
        ]
        
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        service_names = ['Agent Core', 'Memory System', 'Neuro-Symbolic Bridge']
        result_keys = ['agent_core', 'memory_system', 'neuro_symbolic']
        
        for i, (name, key) in enumerate(zip(service_names, result_keys)):
            r = results[i]
            if isinstance(r, Exception):
                result['services_failed'].append((name, str(r)))
            elif isinstance(r, tuple):
                success, response, error = r
                if success:
                    result[key] = response
                    result['services_used'].append(name)
                else:
                    result['services_failed'].append((name, error))
            else:
                result['services_failed'].append((name, 'Unknown result type'))

        return result

    async def should_proactive(self, soul_state: Dict[str, Any], time_since_last: int) -> Dict[str, Any]:
        """
        Proactive speaking is disabled; always return false.
        """
        return {
            'should_proactive': False,
            'reason': 'Proactive speaking disabled',
            'source': 'disabled',
            'fallback': False
        }

    async def tick(self, soul_state: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process tick with proactive check
        
        Args:
            soul_state: Current soul state
            
        Returns:
            Tick result
        """
        result = {
            'success': True,
            'soul_state': soul_state,
            'proactive_decision': None
        }

        # Calculate time since last message
        last_message_time = soul_state.get('last_message_time', 0)
        time_since_last = int((datetime.now().timestamp() - last_message_time) * 1000)

        # Get proactive decision
        proactive_result = await self.should_proactive(soul_state, time_since_last)
        result['proactive_decision'] = proactive_result

        return result

    async def feedback(self, feedback_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process feedback with Reflection Engine
        
        Tries Reflection Engine, continues if unavailable
        
        Args:
            feedback_data: Feedback data
            
        Returns:
            Feedback result
        """
        result = {
            'success': True,
            'feedback_recorded': True,
            'reflection_applied': False
        }

        # Try Reflection Engine
        success, reflection_response, error = await self.call_with_timeout(
            'Reflection Engine',
            f"{self.reflection_engine_url}/feedback",
            'POST',
            feedback_data,
            REFLECTION_ENGINE_TIMEOUT
        )

        if success:
            result['reflection_applied'] = True
            result['reflection_response'] = reflection_response
        else:
            result['reflection_failed'] = error
            logger.warning(f"Reflection Engine failed: {error}")

        return result

    async def predict(self, prediction_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Call Prediction Engine with timeout
        
        Args:
            prediction_data: Data for prediction
            
        Returns:
            Prediction result or None if unavailable
        """
        success, response, error = await self.call_with_timeout(
            'Prediction Engine',
            f"{self.prediction_engine_url}/predict",
            'POST',
            prediction_data,
            PREDICTION_ENGINE_TIMEOUT
        )

        if success:
            return response
        else:
            logger.warning(f"Prediction Engine failed: {error}")
            return None

    def get_fallback_response(self, reason: str) -> Dict[str, Any]:
        """
        Get fallback response
        
        Args:
            reason: Reason for fallback
            
        Returns:
            Fallback response
        """
        return {
            'success': False,
            'text': FALLBACK_MESSAGE,
            'fallback': True,
            'fallback_reason': reason,
            'timestamp': datetime.now().isoformat()
        }

    def _log_fallback(self, service_name: str, reason: str, severity: str = 'warning'):
        """
        Log fallback event
        
        Args:
            service_name: Name of the service
            reason: Reason for fallback
            severity: Log severity (warning, error)
        """
        log_message = {
            'timestamp': datetime.now().isoformat(),
            'service': service_name,
            'reason': reason,
            'severity': severity
        }

        if severity == 'error':
            logger.error(f"[{service_name} Fallback] {reason}")
        else:
            logger.warning(f"[{service_name} Fallback] {reason}")

    async def check_service_health(self, service_name: str, url: str) -> bool:
        """
        Check if a service is available
        
        Args:
            service_name: Name of the service
            url: Service URL
            
        Returns:
            True if service is available, False otherwise
        """
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{url}/health", timeout=aiohttp.ClientTimeout(total=2.0)) as resp:
                    return resp.status == 200
        except Exception:
            return False
