# Fallback System - Quick Reference Guide

## 🚀 Quick Start

### Check System Status
```bash
# Health check
curl http://localhost:8080/api/health-check

# Fallback statistics
curl http://localhost:8080/api/fallback-stats

# Prometheus metrics
curl http://localhost:8080/metrics | grep fallback
```

### View Logs
```bash
# Error logs
tail -f logs/fallback-error.log

# Warning logs
tail -f logs/fallback-warning.log

# All fallback logs
tail -f logs/fallback-*.log
```

### Run Validation
```bash
# Validate deployment
npm run validate:fallback-deployment

# Run end-to-end tests
npm run test:fallback-e2e
```

## 📊 Key Metrics

| Metric | Endpoint | Command |
|--------|----------|---------|
| Fallback Rate | `/api/fallback-stats` | `curl http://localhost:8080/api/fallback-stats \| jq '.fallbackRate'` |
| Service Availability | `/api/health-check` | `curl http://localhost:8080/api/health-check \| jq '.services'` |
| Prometheus Metrics | `/metrics` | `curl http://localhost:8080/metrics \| grep fallback` |
| Error Count | `/api/fallback-stats` | `curl http://localhost:8080/api/fallback-stats \| jq '.totalFallbacks'` |

## ⚙️ Configuration

### Critical Service Timeouts
```env
FALLBACK_LLM_TIMEOUT=15000        # 15 seconds
FALLBACK_TTS_TIMEOUT=10000        # 10 seconds
```

### Non-Critical Service Timeouts
```env
FALLBACK_BRAINNN_TIMEOUT=3000
FALLBACK_AGENT_CORE_TIMEOUT=2000
FALLBACK_MEMORY_SYSTEM_TIMEOUT=2000
FALLBACK_PREDICTION_ENGINE_TIMEOUT=2000
FALLBACK_NEURO_SYMBOLIC_TIMEOUT=2000
FALLBACK_REFLECTION_ENGINE_TIMEOUT=2000
```

### Retry Configuration
```env
FALLBACK_RETRY_MAX_ATTEMPTS=2
FALLBACK_RETRY_INITIAL_DELAY=500
FALLBACK_RETRY_BACKOFF_MULTIPLIER=2
```

## 🔍 Troubleshooting

### High Fallback Rate
```bash
# 1. Check which service is failing
curl http://localhost:8080/api/fallback-stats | jq '.fallbacksByService'

# 2. Check service health
curl http://localhost:service-port/health

# 3. Check logs
grep "ERROR" logs/fallback-error.log | head -20

# 4. Increase timeout if needed
# Edit .env: FALLBACK_SERVICE_TIMEOUT=20000
# Restart: pm2 restart all
```

### Service Timeout
```bash
# 1. Measure response time
for i in {1..10}; do
  curl -w "%{time_total}\n" -o /dev/null -s http://localhost:service-port/endpoint
done

# 2. Calculate P95 response time
# 3. Set timeout = P95 + 1000ms
# 4. Update .env and restart
```

### Metrics Not Appearing
```bash
# 1. Check metrics endpoint
curl http://localhost:8080/metrics

# 2. Check Prometheus scrape
curl http://localhost:9090/api/v1/targets

# 3. Restart Prometheus
systemctl restart prometheus
```

### Alerts Not Firing
```bash
# 1. Check alert rules
curl http://localhost:9090/api/v1/rules

# 2. Check alert status
curl http://localhost:9090/api/v1/alerts

# 3. Check AlertManager
curl http://localhost:9093/api/v1/alerts
```

## 📈 Monitoring

### Grafana Dashboard
- URL: http://localhost:3000
- Dashboard: "Fallback System Monitoring"
- Panels: 8 (rate, count, availability, latency, errors, recovery, etc.)

### Prometheus Queries
```promql
# Fallback rate
fallback_rate{service="llm"}

# Service availability
service_availability{service="llm"}

# Error rate
rate(error_total[5m])

# Response time P95
histogram_quantile(0.95, service_response_time_ms)
```

### Alert Rules
- **Critical**: Fallback rate > 10%, Service down, Multiple failures
- **Warning**: Fallback rate > 5%, High latency, Timeout threshold
- **Info**: Fallback events, Recovery events

## 🛠️ Common Commands

### Service Management
```bash
# Start all services
pm2 start pm2.config.cjs

# Stop all services
pm2 stop all

# Restart all services
pm2 restart all

# View service status
pm2 status

# View service logs
pm2 logs service-name
```

### Testing
```bash
# Test LLM fallback
pm2 stop llm
curl http://localhost:4005/api/chat -X POST -d '{"message":"test","userId":"test"}'
pm2 start llm

# Test TTS fallback
pm2 stop tts
curl http://localhost:4005/api/chat -X POST -d '{"message":"test","userId":"test"}'
pm2 start tts

# Test BrainNN fallback
pm2 stop brainnn
curl http://localhost:4005/api/chat -X POST -d '{"message":"test","userId":"test"}'
pm2 start brainnn
```

### Diagnostics
```bash
# Check port availability
netstat -ano | findstr :port

# Check process memory
ps aux | grep node

# Check disk space
df -h

# Check system load
top
```

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| [FALLBACK_SYSTEM.md](./FALLBACK_SYSTEM.md) | System architecture & design |
| [FALLBACK_TROUBLESHOOTING.md](./FALLBACK_TROUBLESHOOTING.md) | Troubleshooting procedures |
| [FALLBACK_MONITORING.md](./FALLBACK_MONITORING.md) | Monitoring setup |
| [FALLBACK_DEPLOYMENT_GUIDE.md](./FALLBACK_DEPLOYMENT_GUIDE.md) | Deployment instructions |
| [PHASE8_COMPLETION_SUMMARY.md](./PHASE8_COMPLETION_SUMMARY.md) | Phase 8 summary |

## 🎯 Performance Targets

| Metric | Target | Acceptable | Warning |
|--------|--------|-----------|---------|
| Fallback Detection | < 5ms | < 10ms | > 20ms |
| Fallback Response | < 50ms | < 100ms | > 200ms |
| Service Availability | > 99% | > 95% | < 90% |
| Fallback Rate | < 1% | < 5% | > 10% |

## 🚨 Alert Thresholds

| Alert | Threshold | Severity |
|-------|-----------|----------|
| High Fallback Rate | > 5% | Warning |
| Critical Fallback Rate | > 10% | Critical |
| Service Unavailable | < 95% | Critical |
| High Latency | > 50ms | Warning |
| Critical Latency | > 100ms | Critical |
| High Error Rate | > 0.01/sec | Warning |
| Critical Error Rate | > 0.05/sec | Critical |

## 💡 Best Practices

### For Operators
1. Monitor fallback rate daily
2. Review logs weekly
3. Adjust timeouts based on metrics
4. Keep documentation updated
5. Test fallback scenarios monthly

### For Developers
1. Always wrap service calls with fallback
2. Categorize errors correctly
3. Log all fallback events
4. Write tests for fallback paths
5. Monitor performance impact

## 🔗 Related Resources

- [System Architecture](../ARCHITECTURE.md)
- [Configuration Guide](./.env.example)
- [README](../README.md)
- [Prometheus Rules](./prometheus-rules.yml)
- [Grafana Dashboard](./grafana-fallback-dashboard.json)
- [AlertManager Config](./alertmanager-config.yml)

## 📞 Support

### Quick Help
- Check logs: `tail -f logs/fallback-*.log`
- Check health: `curl http://localhost:8080/api/health-check`
- Check metrics: `curl http://localhost:8080/metrics`

### Detailed Help
- See [FALLBACK_TROUBLESHOOTING.md](./FALLBACK_TROUBLESHOOTING.md)
- See [FALLBACK_MONITORING.md](./FALLBACK_MONITORING.md)

### Emergency
1. Check service status: `pm2 status`
2. Check logs: `tail -f logs/fallback-error.log`
3. Restart services: `pm2 restart all`
4. Verify recovery: `curl http://localhost:8080/api/health-check`

</content>
