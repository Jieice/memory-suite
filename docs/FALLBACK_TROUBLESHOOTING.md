# Fallback System Troubleshooting Guide

## Quick Diagnosis

### Step 1: Check Service Status

```bash
# Check all services
curl http://localhost:8080/api/health-check

# Check individual services
curl http://localhost:4005/health  # Memory Universe
curl http://localhost:4007/health  # BrainNN
curl http://localhost:4014/health  # TTS
curl http://localhost:4008/health  # LLM
```

### Step 2: Check Fallback Logs

```bash
# View recent fallback errors
tail -f logs/fallback-error.log

# View recent fallback warnings
tail -f logs/fallback-warning.log

# Search for specific service
grep "LLM" logs/fallback-error.log
grep "TTS" logs/fallback-error.log
```

### Step 3: Check Metrics

```bash
# View fallback statistics
curl http://localhost:8080/api/fallback-stats

# View Prometheus metrics
curl http://localhost:8080/metrics | grep fallback
```

## Common Issues and Solutions

### Issue 1: Users See Fallback Message Frequently

**Symptom**: Many users report seeing "璇峰憡璇夋垜鐨勫垱閫犺€咃紝鎴戠殑ai鍑虹幇闂浜?

**Diagnosis**:

```bash
# Check fallback rate
curl http://localhost:8080/api/fallback-stats | jq '.fallbackRate'

# Check which service is failing
curl http://localhost:8080/api/fallback-stats | jq '.fallbacksByService'

# Check logs for error patterns
grep "ERROR" logs/fallback-error.log | head -20
```

**Solutions**:

#### If LLM is failing:

```bash
# 1. Check LLM service
curl http://localhost:4008/health

# 2. Check LLM logs
tail -f logs/llm-error.log

# 3. Verify LLM connectivity
ping llm-service-host

# 4. Check LLM configuration
echo $DEEPSEEK_API_KEY  # Should not be empty
echo $LOCAL_LLM_URL     # Should be valid

# 5. Increase timeout if needed
# Edit .env: FALLBACK_LLM_TIMEOUT=20000

# 6. Restart LLM service
pm2 restart llm
```

#### If TTS is failing:

```bash
# 1. Check TTS service
curl http://localhost:4014/health

# 2. Check TTS logs
tail -f logs/tts-error.log

# 3. Verify TTS connectivity
ping tts-service-host

# 4. Check TTS configuration
echo $TTS_ENGINE
echo $GENIE_API_URL

# 5. Increase timeout if needed
# Edit .env: FALLBACK_TTS_TIMEOUT=15000

# 6. Restart TTS service
pm2 restart tts
```

### Issue 2: Specific Service Timeouts

**Symptom**: Logs show "SERVICE_TIMEOUT" for a specific service

**Diagnosis**:

```bash
# Check which service is timing out
grep "SERVICE_TIMEOUT" logs/fallback-warning.log | tail -10

# Check service response time
curl -w "@curl-format.txt" -o /dev/null -s http://localhost:service-port/health
```

**Solutions**:

```bash
# 1. Check service status
curl http://localhost:service-port/health

# 2. Check service logs
tail -f logs/service-name-error.log

# 3. Monitor service performance
# Check CPU, memory, disk usage
top
df -h

# 4. Increase timeout
# Edit .env: FALLBACK_SERVICE_TIMEOUT=5000

# 5. Restart service
pm2 restart service-name

# 6. Scale service if needed
# Add more instances or increase resources
```

### Issue 3: High Memory Usage

**Symptom**: Fallback system consuming too much memory

**Diagnosis**:

```bash
# Check memory usage
ps aux | grep node
ps aux | grep python

# Check fallback manager memory
curl http://localhost:8080/api/fallback-stats | jq '.memory'
```

**Solutions**:

```bash
# 1. Clear old logs
rm logs/fallback-*.log

# 2. Reduce metrics retention
# Edit .env: FALLBACK_METRICS_RETENTION_DAYS=7

# 3. Reduce log file size
# Edit .env: FALLBACK_LOG_MAX_SIZE=5242880  # 5MB

# 4. Restart services
pm2 restart all

# 5. Monitor memory usage
watch -n 1 'ps aux | grep node'
```

### Issue 4: Fallback Events Not Being Logged

**Symptom**: No entries in fallback logs despite service failures

**Diagnosis**:

```bash
# Check if logging is enabled
echo $FALLBACK_LOG_LEVEL

# Check if log directory exists
ls -la logs/

# Check log file permissions
ls -la logs/fallback-*.log
```

**Solutions**:

```bash
# 1. Enable logging
# Edit .env: FALLBACK_LOG_LEVEL=info

# 2. Create log directory if missing
mkdir -p logs

# 3. Fix permissions
chmod 755 logs/

# 4. Restart services
pm2 restart all

# 5. Verify logging
curl http://localhost:4005/api/chat -X POST -d '{"message":"test"}' -H "Content-Type: application/json"
tail -f logs/fallback-error.log
```

### Issue 5: Metrics Not Being Collected

**Symptom**: Metrics endpoint returns empty or no fallback metrics

**Diagnosis**:

```bash
# Check if metrics are enabled
echo $FALLBACK_METRICS_ENABLED

# Check metrics endpoint
curl http://localhost:8080/metrics | grep fallback

# Check metrics in stats
curl http://localhost:8080/api/fallback-stats
```

**Solutions**:

```bash
# 1. Enable metrics
# Edit .env: FALLBACK_METRICS_ENABLED=true

# 2. Restart services
pm2 restart all

# 3. Wait for metrics to accumulate
# Metrics are collected over time

# 4. Verify metrics collection
curl http://localhost:8080/api/fallback-stats | jq '.totalFallbacks'
```

### Issue 6: Service Recovery Not Detected

**Symptom**: Service comes back online but fallback continues

**Diagnosis**:

```bash
# Check service status
curl http://localhost:service-port/health

# Check last health check time
curl http://localhost:8080/api/health-check | jq '.services.service-name.lastCheck'

# Check health check interval
echo $FALLBACK_HEALTH_CHECK_INTERVAL
```

**Solutions**:

```bash
# 1. Manually trigger health check
curl http://localhost:8080/api/health-check -X POST

# 2. Reduce health check interval
# Edit .env: FALLBACK_HEALTH_CHECK_INTERVAL=10000  # 10 seconds

# 3. Restart fallback manager
pm2 restart manager

# 4. Verify service is actually healthy
curl http://localhost:service-port/health -v
```

## Performance Tuning

### Optimize Timeout Values

**Current Configuration**:
```env
FALLBACK_LLM_TIMEOUT=15000
FALLBACK_TTS_TIMEOUT=10000
FALLBACK_BRAINNN_TIMEOUT=3000
```

**Tuning Guide**:

1. **Measure baseline response times**:
   ```bash
   for i in {1..10}; do
     curl -w "%{time_total}\n" -o /dev/null -s http://localhost:service-port/endpoint
   done
   ```

2. **Calculate appropriate timeout**:
   - Timeout = (P95 response time) + 1000ms buffer
   - Example: If P95 is 8000ms, set timeout to 9000ms

3. **Monitor timeout effectiveness**:
   ```bash
   grep "SERVICE_TIMEOUT" logs/fallback-warning.log | wc -l
   ```

4. **Adjust if needed**:
   - Too short: Many false timeouts
   - Too long: Slow fallback response

### Optimize Retry Logic

**Current Configuration**:
```env
FALLBACK_RETRY_MAX_ATTEMPTS=2
FALLBACK_RETRY_INITIAL_DELAY=500
FALLBACK_RETRY_BACKOFF_MULTIPLIER=2
```

**Tuning Guide**:

1. **For critical services (LLM, TTS)**:
   - Keep retries enabled
   - Increase attempts if network is unreliable
   - Increase initial delay if service is slow to recover

2. **For non-critical services**:
   - Disable retries (fail fast)
   - Skip service and continue

3. **Monitor retry effectiveness**:
   ```bash
   grep "RETRY" logs/fallback-*.log | wc -l
   ```

### Optimize Logging

**Current Configuration**:
```env
FALLBACK_LOG_LEVEL=info
FALLBACK_LOG_MAX_SIZE=10485760
FALLBACK_LOG_MAX_FILES=10
```

**Tuning Guide**:

1. **For production**:
   - Use `info` level (not `debug`)
   - Rotate logs daily
   - Archive old logs

2. **For debugging**:
   - Use `debug` level temporarily
   - Increase log file size
   - Keep more log files

3. **Monitor log usage**:
   ```bash
   du -sh logs/
   ls -lh logs/fallback-*.log
   ```

## Monitoring and Alerting

### Set Up Prometheus Alerts

Create `prometheus-rules.yml`:

```yaml
groups:
  - name: fallback_alerts
    rules:
      - alert: HighFallbackRate
        expr: fallback_rate > 0.05
        for: 5m
        annotations:
          summary: "High fallback rate detected"
          description: "Fallback rate is {{ $value }}"

      - alert: ServiceUnavailable
        expr: service_availability < 0.95
        for: 5m
        annotations:
          summary: "Service availability below 95%"
          description: "Service {{ $labels.service }} availability is {{ $value }}"

      - alert: HighFallbackLatency
        expr: fallback_latency_ms > 50
        for: 5m
        annotations:
          summary: "High fallback latency"
          description: "Fallback latency is {{ $value }}ms"
```

### Set Up Grafana Dashboard

1. Add Prometheus data source
2. Create dashboard with panels:
   - Fallback rate over time
   - Fallback count by service
   - Service availability
   - Response time distribution
   - Error rate by category

### Set Up Log Alerts

```bash
# Alert on high error rate
grep "ERROR" logs/fallback-error.log | wc -l

# Alert on specific service failures
grep "LLM.*ERROR" logs/fallback-error.log | wc -l

# Alert on timeout patterns
grep "SERVICE_TIMEOUT" logs/fallback-warning.log | wc -l
```

## Testing Fallback Behavior

### Test LLM Fallback

```bash
# Stop LLM service
pm2 stop llm

# Send request
curl http://localhost:4005/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"test","userId":"test-user"}'

# Should return fallback message
# Restart LLM
pm2 start llm
```

### Test TTS Fallback

```bash
# Stop TTS service
pm2 stop tts

# Send request
curl http://localhost:4005/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"test","userId":"test-user"}'

# Should return fallback message
# Restart TTS
pm2 start tts
```

### Test BrainNN Fallback

```bash
# Stop BrainNN service
pm2 stop brainnn

# Send request
curl http://localhost:4005/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"test","userId":"test-user"}'

# Should return response without BrainNN analysis
# Restart BrainNN
pm2 start brainnn
```

### Test Multiple Service Failures

```bash
# Stop multiple services
pm2 stop llm tts brainnn

# Send request
curl http://localhost:4005/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"test","userId":"test-user"}'

# Should return fallback message
# Restart services
pm2 start all
```

## Performance Benchmarks

### Expected Performance

| Metric | Target | Acceptable | Warning |
|--------|--------|-----------|---------|
| Fallback Detection | < 5ms | < 10ms | > 20ms |
| Fallback Response | < 50ms | < 100ms | > 200ms |
| Service Availability | > 99% | > 95% | < 90% |
| Fallback Rate | < 1% | < 5% | > 10% |
| Log Write Time | < 20ms | < 50ms | > 100ms |

### Benchmark Test

```bash
# Run performance test
npm run test:fallback-performance

# Expected output:
# Fallback Detection: 3.2ms
# Fallback Response: 42.1ms
# Service Availability: 99.8%
# Fallback Rate: 0.3%
```

## Getting Help

### Check Documentation

- [Fallback System Overview](./FALLBACK_SYSTEM.md)
- [Monitoring Setup](./FALLBACK_MONITORING.md)
- [Configuration Guide](./.env.example)

### Check Logs

```bash
# View all fallback logs
tail -f logs/fallback-*.log

# Search for specific errors
grep "ERROR" logs/fallback-error.log
grep "TIMEOUT" logs/fallback-warning.log
```

### Run Diagnostics

```bash
# Run full diagnostic
npm run diagnose:fallback

# Run service health check
npm run check:services

# Run performance test
npm run test:fallback-performance
```

### Contact Support

If issues persist:
1. Collect logs: `tar -czf fallback-logs.tar.gz logs/`
2. Run diagnostics: `npm run diagnose:fallback > diagnostics.txt`
3. Include system info: `uname -a > system-info.txt`
4. Submit to support team

</content>

