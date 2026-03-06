# Fallback System Deployment Guide

## Overview

This guide provides step-by-step instructions for deploying the Graceful Degradation & Fallback System in production.

## Pre-Deployment Checklist

### 1. Code Review
- [ ] All fallback handlers are implemented
- [ ] All endpoints are wrapped with fallback logic
- [ ] Error categorization is correct
- [ ] Logging is configured
- [ ] Metrics are enabled

### 2. Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Property-based tests pass
- [ ] End-to-end tests pass
- [ ] Fallback scenarios tested manually

### 3. Documentation
- [ ] FALLBACK_SYSTEM.md is complete
- [ ] FALLBACK_TROUBLESHOOTING.md is complete
- [ ] FALLBACK_MONITORING.md is complete
- [ ] README.md is updated
- [ ] .env.example is updated

### 4. Configuration
- [ ] .env file has all fallback settings
- [ ] Timeout values are appropriate
- [ ] Retry configuration is set
- [ ] Logging paths are valid
- [ ] Metrics are enabled

### 5. Monitoring
- [ ] Prometheus is configured
- [ ] Grafana dashboard is imported
- [ ] Alert rules are configured
- [ ] Notification channels are set up
- [ ] Health check endpoints are working

## Deployment Steps

### Step 1: Prepare Environment

```bash
# 1. Create log directory
mkdir -p logs

# 2. Verify .env file
cat .env | grep FALLBACK_

# 3. Check service ports
netstat -ano | findstr :4005
netstat -ano | findstr :4007
netstat -ano | findstr :4014
```

### Step 2: Deploy Code

```bash
# 1. Pull latest code
git pull origin main

# 2. Install dependencies
npm install

# 3. Build TypeScript
npm run build

# 4. Run tests
npm run test
npm run test:integration
npm run test:property
```

### Step 3: Deploy Services

```bash
# 1. Stop existing services
pm2 stop all

# 2. Start services with new code
pm2 start pm2.config.cjs

# 3. Verify services are running
pm2 status

# 4. Check service health
curl http://localhost:8080/api/health-check
```

### Step 4: Validate Deployment

```bash
# 1. Run deployment validation
npm run validate:fallback-deployment

# 2. Check logs for errors
tail -f logs/fallback-error.log

# 3. Monitor metrics
curl http://localhost:8080/metrics | grep fallback

# 4. Test fallback scenarios
npm run test:fallback-e2e
```

### Step 5: Set Up Monitoring

```bash
# 1. Configure Prometheus
cp docs/prometheus-rules.yml /etc/prometheus/rules/
systemctl restart prometheus

# 2. Import Grafana dashboard
# - Open Grafana: http://localhost:3000
# - Go to Dashboards 鈫?Import
# - Upload docs/grafana-fallback-dashboard.json

# 3. Configure AlertManager
cp docs/alertmanager-config.yml /etc/alertmanager/
# - Update notification channels
systemctl restart alertmanager

# 4. Verify monitoring
curl http://localhost:9090/api/v1/rules
curl http://localhost:9093/api/v1/alerts
```

### Step 6: Smoke Testing

```bash
# 1. Test normal flow
curl http://localhost:4005/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","userId":"test"}'

# 2. Test with service down
pm2 stop llm
curl http://localhost:4005/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","userId":"test"}'
# Should return fallback message

# 3. Restart service
pm2 start llm

# 4. Verify recovery
curl http://localhost:4005/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","userId":"test"}'
# Should return normal response
```

### Step 7: Production Verification

```bash
# 1. Check all services are healthy
curl http://localhost:8080/api/health-check | jq '.services'

# 2. Check fallback stats
curl http://localhost:8080/api/fallback-stats | jq '.fallbackRate'

# 3. Monitor logs
tail -f logs/fallback-*.log

# 4. Check metrics
curl http://localhost:8080/metrics | grep fallback_total

# 5. Verify alerts are working
# - Trigger a test alert
# - Verify notification is received
```

## Rollback Procedure

If issues occur during deployment:

```bash
# 1. Stop services
pm2 stop all

# 2. Revert code
git revert HEAD

# 3. Rebuild
npm run build

# 4. Restart services
pm2 start pm2.config.cjs

# 5. Verify
curl http://localhost:8080/api/health-check
```

## Post-Deployment Tasks

### 1. Monitor for 24 Hours

- Watch fallback rate
- Monitor error logs
- Check alert notifications
- Verify service availability

### 2. Collect Baseline Metrics

```bash
# Get baseline metrics
curl http://localhost:8080/api/fallback-stats > baseline-metrics.json

# Compare with expected values
# - Fallback rate should be < 1%
# - Service availability should be > 99%
# - Average latency should be < 50ms
```

### 3. Document Issues

- Record any anomalies
- Document resolution steps
- Update runbooks if needed

### 4. Team Communication

- Notify team of deployment
- Share monitoring dashboard
- Provide runbook links
- Schedule follow-up review

## Configuration Tuning

### Adjust Timeout Values

If you see high timeout rates:

```bash
# 1. Measure current response times
for i in {1..10}; do
  curl -w "%{time_total}\n" -o /dev/null -s http://localhost:service-port/endpoint
done

# 2. Calculate P95 response time
# 3. Set timeout = P95 + 1000ms buffer
# 4. Update .env
# 5. Restart services
```

### Adjust Retry Configuration

If you see high error rates:

```bash
# 1. Check error logs
grep "ERROR" logs/fallback-error.log | head -20

# 2. If transient errors, increase retries
# FALLBACK_RETRY_MAX_ATTEMPTS=3

# 3. If persistent errors, increase initial delay
# FALLBACK_RETRY_INITIAL_DELAY=1000

# 4. Restart services
pm2 restart all
```

### Adjust Alert Thresholds

If you see too many false alerts:

```bash
# 1. Review alert history
# 2. Adjust thresholds based on baseline
# 3. Update prometheus-rules.yml
# 4. Reload Prometheus
curl -X POST http://localhost:9090/-/reload
```

## Troubleshooting

### Services Not Starting

```bash
# 1. Check logs
pm2 logs

# 2. Check port availability
netstat -ano | findstr :port

# 3. Check configuration
cat .env | grep FALLBACK_

# 4. Check permissions
ls -la logs/
```

### High Fallback Rate

```bash
# 1. Check service health
curl http://localhost:service-port/health

# 2. Check service logs
tail -f logs/service-error.log

# 3. Check network connectivity
ping service-host

# 4. Check timeout configuration
echo $FALLBACK_SERVICE_TIMEOUT
```

### Metrics Not Appearing

```bash
# 1. Check metrics endpoint
curl http://localhost:8080/metrics

# 2. Check Prometheus scrape config
curl http://localhost:9090/api/v1/targets

# 3. Check Prometheus logs
tail -f /var/log/prometheus/prometheus.log
```

### Alerts Not Firing

```bash
# 1. Check alert rules
curl http://localhost:9090/api/v1/rules

# 2. Check alert status
curl http://localhost:9090/api/v1/alerts

# 3. Check AlertManager
curl http://localhost:9093/api/v1/alerts

# 4. Check notification channel
# - Verify Slack webhook
# - Verify email configuration
# - Verify PagerDuty key
```

## Performance Benchmarks

After deployment, verify performance:

| Metric | Target | Acceptable | Warning |
|--------|--------|-----------|---------|
| Fallback Detection | < 5ms | < 10ms | > 20ms |
| Fallback Response | < 50ms | < 100ms | > 200ms |
| Service Availability | > 99% | > 95% | < 90% |
| Fallback Rate | < 1% | < 5% | > 10% |
| Log Write Time | < 20ms | < 50ms | > 100ms |

## Maintenance Schedule

### Daily
- Monitor fallback rate
- Check error logs
- Verify alerts are working

### Weekly
- Review fallback trends
- Analyze error patterns
- Update runbooks if needed

### Monthly
- Review alert thresholds
- Analyze root causes
- Plan improvements

### Quarterly
- Full system review
- Performance analysis
- Capacity planning

## Support and Escalation

### Level 1: Automated Response
- Alerts are sent automatically
- Runbooks are provided
- Metrics are available

### Level 2: Manual Investigation
- Check logs and metrics
- Follow troubleshooting guide
- Escalate if needed

### Level 3: Engineering Team
- Deep dive analysis
- Code review
- System redesign if needed

## Related Documentation

- [Fallback System Overview](./FALLBACK_SYSTEM.md)
- [Troubleshooting Guide](./FALLBACK_TROUBLESHOOTING.md)
- [Monitoring Setup](./FALLBACK_MONITORING.md)
- [Configuration Guide](./.env.example)

</content>

