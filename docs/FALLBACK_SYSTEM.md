# Graceful Degradation & Fallback System

## Overview

The Fallback System is a critical component of Memory Suite that ensures the AI system continues operating gracefully when any service becomes unavailable. Instead of crashing or showing error messages to users, the system returns a unified fallback message and continues processing.

**Unified Fallback Message**: `"璇峰憡璇夋垜鐨勫垱閫犺€咃紝鎴戠殑ai鍑虹幇闂浜?`

This message is returned whenever a critical service (LLM, TTS) fails, ensuring users never see technical errors or blank responses.

## Architecture

```
鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
鈹?                   Fallback Manager                         鈹?
鈹? (Centralized fallback handling & error recovery)           鈹?
鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
                       鈹?
        鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹尖攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
        鈹?             鈹?             鈹?
        鈻?             鈻?             鈻?
鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
鈹?LLM Fallback 鈹?鈹?TTS Fallback 鈹?鈹?BrainNN      鈹?
鈹?Handler      鈹?鈹?Handler      鈹?鈹?Fallback     鈹?
鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
        鈹?             鈹?             鈹?
        鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹尖攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
                       鈹?
                       鈻?
        鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
        鈹? Fallback Message Template   鈹?
        鈹? "璇峰憡璇夋垜鐨勫垱閫犺€咃紝鎴戠殑ai   鈹?
        鈹?  鍑虹幇闂浜?                鈹?
        鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
```

## Service Classification

### Critical Services (Return Fallback Message)

These services directly impact user-facing responses. When they fail, the system returns the unified fallback message:

- **LLM (Language Model)**: Generates AI responses
  - Timeout: 15 seconds
  - Retry: 2 attempts with exponential backoff
  - Fallback: Return unified message

- **TTS (Text-to-Speech)**: Synthesizes audio
  - Timeout: 10 seconds
  - Retry: 2 attempts with exponential backoff
  - Fallback: Return unified message

### Non-Critical Services (Skip & Continue)

These services enhance the response but aren't essential. When they fail, the system skips them and continues:

- **BrainNN**: Neural network analysis
  - Timeout: 3 seconds
  - Retry: None (skip on failure)
  - Fallback: Continue without analysis

- **Agent Core**: Thinking and planning
  - Timeout: 2 seconds
  - Retry: None (skip on failure)
  - Fallback: Use degraded logic

- **Memory System V2**: Vector database
  - Timeout: 2 seconds
  - Retry: None (skip on failure)
  - Fallback: Continue without memory storage

- **Prediction Engine**: Risk assessment
  - Timeout: 2 seconds
  - Retry: None (skip on failure)
  - Fallback: Skip prediction check

- **Neuro-Symbolic Bridge**: Rule checking
  - Timeout: 2 seconds
  - Retry: None (skip on failure)
  - Fallback: Skip rule check

- **Reflection Engine**: Learning feedback
  - Timeout: 2 seconds
  - Retry: None (skip on failure)
  - Fallback: Skip reflection

## Timeout Configuration

All timeout values are configurable via environment variables:

```env
# Critical services (longer timeouts)
FALLBACK_LLM_TIMEOUT=15000           # 15 seconds
FALLBACK_TTS_TIMEOUT=10000           # 10 seconds

# Non-critical services (shorter timeouts)
FALLBACK_BRAINNN_TIMEOUT=3000        # 3 seconds
FALLBACK_AGENT_CORE_TIMEOUT=2000     # 2 seconds
FALLBACK_MEMORY_SYSTEM_TIMEOUT=2000  # 2 seconds
FALLBACK_PREDICTION_ENGINE_TIMEOUT=2000  # 2 seconds
FALLBACK_NEURO_SYMBOLIC_TIMEOUT=2000 # 2 seconds
FALLBACK_REFLECTION_ENGINE_TIMEOUT=2000  # 2 seconds
```

## Retry Logic

### Critical Services (LLM, TTS)

Retry with exponential backoff:

```
Attempt 1: Immediate
Attempt 2: After 500ms (if first fails)
Attempt 3: After 1000ms (if second fails)
```

Configuration:

```env
FALLBACK_RETRY_MAX_ATTEMPTS=2
FALLBACK_RETRY_INITIAL_DELAY=500     # milliseconds
FALLBACK_RETRY_BACKOFF_MULTIPLIER=2
```

### Non-Critical Services

No retry - fail fast and continue.

## Error Categorization

The system categorizes errors to determine the appropriate fallback behavior:

### Critical Errors (Return Fallback Message)

- `LLM_UNAVAILABLE`: LLM service is down
- `TTS_UNAVAILABLE`: TTS service is down
- `LLM_TIMEOUT`: LLM request exceeded timeout
- `TTS_TIMEOUT`: TTS request exceeded timeout
- `LLM_ERROR`: LLM returned error status
- `TTS_ERROR`: TTS returned error status

### Non-Critical Errors (Skip & Continue)

- `BRAINNN_UNAVAILABLE`: BrainNN service is down
- `AGENT_CORE_UNAVAILABLE`: Agent Core is down
- `MEMORY_SYSTEM_UNAVAILABLE`: Memory System is down
- `PREDICTION_ENGINE_UNAVAILABLE`: Prediction Engine is down
- `NEURO_SYMBOLIC_UNAVAILABLE`: Neuro-Symbolic Bridge is down
- `REFLECTION_ENGINE_UNAVAILABLE`: Reflection Engine is down

### Network Errors

- `CONNECTION_REFUSED`: Service refused connection
- `DNS_RESOLUTION_FAILED`: Cannot resolve service hostname
- `SERVICE_TIMEOUT`: Service didn't respond in time

## Logging and Metrics

### Logging

All fallback events are logged with the following information:

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "service": "LLM",
  "errorCategory": "LLM_TIMEOUT",
  "severity": "error",
  "message": "LLM request exceeded 15000ms timeout",
  "fallbackType": "RETURN_MESSAGE",
  "duration": 15023,
  "userId": "user123",
  "sessionId": "session456"
}
```

Log files are stored in:
- `logs/fallback-error.log` - Critical fallback events
- `logs/fallback-warning.log` - Non-critical fallback events
- `logs/fallback-metrics.log` - Metrics and statistics

### Metrics

The system collects the following metrics:

- **Fallback Count**: Total number of fallback events per service
- **Fallback Rate**: Percentage of requests that triggered fallback
- **Average Response Time**: Average time to detect and handle fallback
- **Service Availability**: Percentage of time each service is available
- **Recovery Time**: Time from fallback to service recovery

Metrics are exported in Prometheus format at `/metrics` endpoint.

## Data Flow Examples

### Normal Flow (All Services Available)

```
User Input
  鈫?
Memory Universe /api/chat
  鈹溾攢鈫?BrainNN /think (success)
  鈹溾攢鈫?LLM (success)
  鈹溾攢鈫?TTS (success)
  鈹斺攢鈫?Return response with audio
```

### Degraded Flow (LLM Unavailable)

```
User Input
  鈫?
Memory Universe /api/chat
  鈹溾攢鈫?BrainNN /think (success)
  鈹溾攢鈫?LLM (TIMEOUT/ERROR)
  鈹?  鈹斺攢鈫?Fallback triggered
  鈹?  鈹斺攢鈫?Log error event
  鈹?  鈹斺攢鈫?Record metric
  鈹斺攢鈫?Return fallback message
```

### Degraded Flow (TTS Unavailable)

```
User Input
  鈫?
Memory Universe /api/chat
  鈹溾攢鈫?BrainNN /think (success)
  鈹溾攢鈫?LLM (success)
  鈹溾攢鈫?TTS (TIMEOUT/ERROR)
  鈹?  鈹斺攢鈫?Fallback triggered
  鈹?  鈹斺攢鈫?Log error event
  鈹?  鈹斺攢鈫?Record metric
  鈹斺攢鈫?Return fallback message
```

### Degraded Flow (BrainNN Unavailable)

```
User Input
  鈫?
Memory Universe /api/chat
  鈹溾攢鈫?BrainNN /think (TIMEOUT/ERROR)
  鈹?  鈹斺攢鈫?Skip, continue
  鈹?  鈹斺攢鈫?Log warning event
  鈹?  鈹斺攢鈫?Record metric
  鈹溾攢鈫?LLM (success)
  鈹溾攢鈫?TTS (success)
  鈹斺攢鈫?Return response (without BrainNN analysis)
```

### Multiple Service Failures

```
User Input
  鈫?
Memory Universe /api/chat
  鈹溾攢鈫?BrainNN /think (TIMEOUT)
  鈹?  鈹斺攢鈫?Skip, continue
  鈹溾攢鈫?LLM (ERROR)
  鈹?  鈹斺攢鈫?Fallback triggered
  鈹?  鈹斺攢鈫?Log error event
  鈹斺攢鈫?Return fallback message
```

## Performance Characteristics

### Latency Impact

The fallback system is designed to add minimal latency:

- **Timeout Detection**: < 5ms
- **Fallback Message Generation**: < 10ms
- **Logging**: < 20ms
- **Total Overhead**: < 50ms

### Resource Usage

- **Memory**: ~5MB for fallback manager and caches
- **CPU**: Negligible (< 1% during normal operation)
- **Disk I/O**: Minimal (only for logging)

## Configuration

### Environment Variables

```env
# Fallback System Enable/Disable
FALLBACK_SYSTEM_ENABLED=true

# Timeout Configuration
FALLBACK_LLM_TIMEOUT=15000
FALLBACK_TTS_TIMEOUT=10000
FALLBACK_BRAINNN_TIMEOUT=3000
FALLBACK_AGENT_CORE_TIMEOUT=2000
FALLBACK_MEMORY_SYSTEM_TIMEOUT=2000
FALLBACK_PREDICTION_ENGINE_TIMEOUT=2000
FALLBACK_NEURO_SYMBOLIC_TIMEOUT=2000
FALLBACK_REFLECTION_ENGINE_TIMEOUT=2000

# Retry Configuration
FALLBACK_RETRY_MAX_ATTEMPTS=2
FALLBACK_RETRY_INITIAL_DELAY=500
FALLBACK_RETRY_BACKOFF_MULTIPLIER=2

# Logging Configuration
FALLBACK_LOG_LEVEL=info
FALLBACK_LOG_FILE_PATH=./logs/fallback
FALLBACK_LOG_MAX_SIZE=10485760  # 10MB
FALLBACK_LOG_MAX_FILES=10

# Metrics Configuration
FALLBACK_METRICS_ENABLED=true
FALLBACK_METRICS_EXPORT_INTERVAL=60000  # 1 minute
FALLBACK_METRICS_RETENTION_DAYS=30
```

## Health Checks

The system performs periodic health checks on all services:

```
GET /health-check
```

Response:

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "status": "healthy",
  "services": {
    "llm": {
      "status": "healthy",
      "responseTime": 45,
      "lastCheck": "2024-01-15T10:30:45.123Z"
    },
    "tts": {
      "status": "healthy",
      "responseTime": 32,
      "lastCheck": "2024-01-15T10:30:45.123Z"
    },
    "brainnn": {
      "status": "healthy",
      "responseTime": 28,
      "lastCheck": "2024-01-15T10:30:45.123Z"
    },
    "agent_core": {
      "status": "degraded",
      "responseTime": 2001,
      "lastCheck": "2024-01-15T10:30:45.123Z",
      "error": "Timeout"
    }
  },
  "fallbackStats": {
    "totalFallbacks": 42,
    "fallbacksByService": {
      "llm": 5,
      "tts": 3,
      "brainnn": 34
    },
    "fallbackRate": 0.012
  }
}
```

## Best Practices

### For Operators

1. **Monitor Fallback Rates**: High fallback rates indicate service issues
2. **Check Logs Regularly**: Review fallback logs for patterns
3. **Set Up Alerts**: Configure alerts for high fallback rates
4. **Adjust Timeouts**: Tune timeouts based on your infrastructure
5. **Test Fallback Behavior**: Regularly test fallback scenarios

### For Developers

1. **Always Wrap Service Calls**: Use `executeWithFallback()` for all service calls
2. **Categorize Errors**: Use appropriate error categories
3. **Log Fallback Events**: Include context in logs
4. **Test Fallback Paths**: Write tests for fallback scenarios
5. **Monitor Performance**: Track fallback latency

## Troubleshooting

### High Fallback Rate for LLM

**Symptoms**: Many requests return fallback message

**Causes**:
- LLM service is down
- Network connectivity issues
- LLM timeout is too short
- LLM is overloaded

**Solutions**:
1. Check LLM service status: `curl http://localhost:4008/health`
2. Check network connectivity: `ping llm-service`
3. Increase timeout: `FALLBACK_LLM_TIMEOUT=20000`
4. Check LLM logs for errors
5. Restart LLM service

### High Fallback Rate for TTS

**Symptoms**: Many requests return fallback message

**Causes**:
- TTS service is down
- Network connectivity issues
- TTS timeout is too short
- TTS is overloaded

**Solutions**:
1. Check TTS service status: `curl http://localhost:4014/health`
2. Check network connectivity: `ping tts-service`
3. Increase timeout: `FALLBACK_TTS_TIMEOUT=15000`
4. Check TTS logs for errors
5. Restart TTS service

### Non-Critical Service Timeouts

**Symptoms**: Responses are missing analysis or features

**Causes**:
- Service is slow or overloaded
- Timeout is too short
- Network issues

**Solutions**:
1. Check service status: `curl http://service:port/health`
2. Increase timeout: `FALLBACK_SERVICE_TIMEOUT=5000`
3. Check service logs
4. Monitor service performance

## Related Documentation

- [Fallback Troubleshooting Guide](./FALLBACK_TROUBLESHOOTING.md)
- [Fallback Monitoring Setup](./FALLBACK_MONITORING.md)
- [System Architecture](../ARCHITECTURE.md)
- [Configuration Guide](./.env.example)

</content>

