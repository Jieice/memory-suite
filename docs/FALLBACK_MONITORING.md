# Fallback System Monitoring Setup

## Overview

The Fallback System provides comprehensive monitoring capabilities through Prometheus metrics, Grafana dashboards, and alerting rules. This guide explains how to set up and use these monitoring tools.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Fallback System                          │
│  (Generates metrics and logs)                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Prometheus   │ │ Grafana      │ │ Alert        │
│ Metrics      │ │ Dashboard    │ │ Manager      │
└──────────────┘ └──────────────┘ └──────────────┘
        │              │              │
        └──────────────┼──────────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │  Monitoring & Alerting       │
        │  (Real-time visibility)      │
        └──────────────────────────────┘
```

## Prometheus Metrics

### Available Metrics

#### Fallback Events

```
# Total number of fallback events
fallback_total{service="llm",type="timeout"} 42
fallback_total{service="tts",type="error"} 15
fallback_total{service="brainnn",type="timeout"} 128

# Fallback rate (percentage)
fallback_rate{service="llm"} 0.012
fallback_rate{service="tts"} 0.008
fallback_rate{service="brainnn"} 0.045

# Fallback latency (milliseconds)
fallback_latency_ms{service="llm",quantile="0.5"} 12
fallback_latency_ms{service="llm",quantile="0.95"} 28
fallback_latency_ms{service="llm",quantile="0.99"} 42
```

#### Service Availability

```
# Service availability (percentage)
service_availability{service="llm"} 0.988
service_availability{service="tts"} 0.992
service_availability{service="brainnn"} 0.955

# Service response time (milliseconds)
service_response_time_ms{service="llm",quantile="0.5"} 245
service_response_time_ms{service="llm",quantile="0.95"} 1200
service_response_time_ms{service="llm",quantile="0.99"} 2100
```

#### Error Categories

```
# Errors by category
error_total{category="LLM_TIMEOUT"} 42
error_total{category="TTS_ERROR"} 15
error_total{category="CONNECTION_REFUSED"} 8
error_total{category="DNS_RESOLUTION_FAILED"} 3

# Errors by severity
error_total{severity="error"} 65
error_total{severity="warning"} 128
error_total{severity="critical"} 5
```

#### Recovery Metrics

```
# Service recovery time (milliseconds)
recovery_time_ms{service="llm"} 2345
recovery_time_ms{service="tts"} 1234

# Time to detect failure (milliseconds)
failure_detection_time_ms{service="llm"} 15023
failure_detection_time_ms{service="tts"} 10012
```

### Querying Metrics

#### Get Fallback Rate for LLM

```promql
fallback_rate{service="llm"}
```

#### Get Total Fallbacks in Last Hour

```promql
increase(fallback_total[1h])
```

#### Get Average Fallback Latency

```promql
avg(fallback_latency_ms)
```

#### Get Service Availability

```promql
service_availability{service="llm"}
```

#### Get Error Rate by Category

```promql
rate(error_total[5m])
```

## Grafana Dashboard

### Dashboard JSON

Create a new dashboard with the following panels:

#### Panel 1: Fallback Rate Over Time

```json
{
  "title": "Fallback Rate Over Time",
  "targets": [
    {
      "expr": "fallback_rate{service=~\"$service\"}"
    }
  ],
  "type": "graph",
  "yaxes": [
    {
      "label": "Fallback Rate (%)",
      "format": "percent"
    }
  ]
}
```

#### Panel 2: Fallback Count by Service

```json
{
  "title": "Fallback Count by Service",
  "targets": [
    {
      "expr": "fallback_total{service=~\"$service\"}"
    }
  ],
  "type": "graph",
  "stacking": "normal"
}
```

#### Panel 3: Service Availability

```json
{
  "title": "Service Availability",
  "targets": [
    {
      "expr": "service_availability{service=~\"$service\"}"
    }
  ],
  "type": "gauge",
  "thresholds": "0.95,0.99"
}
```

#### Panel 4: Response Time Distribution

```json
{
  "title": "Response Time Distribution",
  "targets": [
    {
      "expr": "service_response_time_ms{service=~\"$service\",quantile=~\"0.5|0.95|0.99\"}"
    }
  ],
  "type": "graph"
}
```

#### Panel 5: Error Rate by Category

```json
{
  "title": "Error Rate by Category",
  "targets": [
    {
      "expr": "rate(error_total[5m])"
    }
  ],
  "type": "graph",
  "stacking": "normal"
}
```

#### Panel 6: Recovery Time

```json
{
  "title": "Service Recovery Time",
  "targets": [
    {
      "expr": "recovery_time_ms{service=~\"$service\"}"
    }
  ],
  "type": "graph"
}
```

### Dashboard Variables

Add the following variables for filtering:

```json
{
  "name": "service",
  "type": "query",
  "datasource": "Prometheus",
  "query": "label_values(fallback_total, service)",
  "multi": true,
  "includeAll": true
}
```

## Alerting Rules

### Prometheus Alert Rules

Create `prometheus-rules.yml`:

```yaml
groups:
  - name: fallback_alerts
    interval: 30s
    rules:
      # Alert 1: High Fallback Rate
      - alert: HighFallbackRate
        expr: fallback_rate > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High fallback rate for {{ $labels.service }}"
          description: "Fallback rate is {{ $value | humanizePercentage }} (threshold: 5%)"

      # Alert 2: Critical Fallback Rate
      - alert: CriticalFallbackRate
        expr: fallback_rate > 0.10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Critical fallback rate for {{ $labels.service }}"
          description: "Fallback rate is {{ $value | humanizePercentage }} (threshold: 10%)"

      # Alert 3: Service Unavailable
      - alert: ServiceUnavailable
        expr: service_availability < 0.95
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Service {{ $labels.service }} availability below 95%"
          description: "Availability is {{ $value | humanizePercentage }}"

      # Alert 4: High Fallback Latency
      - alert: HighFallbackLatency
        expr: fallback_latency_ms > 50
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High fallback latency for {{ $labels.service }}"
          description: "Latency is {{ $value }}ms (threshold: 50ms)"

      # Alert 5: Service Response Time Degradation
      - alert: ServiceResponseTimeDegradation
        expr: service_response_time_ms{quantile="0.95"} > 5000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Service {{ $labels.service }} response time degradation"
          description: "P95 response time is {{ $value }}ms (threshold: 5000ms)"

      # Alert 6: High Error Rate
      - alert: HighErrorRate
        expr: rate(error_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanize }}/sec"

      # Alert 7: Repeated Failures
      - alert: RepeatedServiceFailures
        expr: increase(error_total[10m]) > 10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Repeated failures for {{ $labels.service }}"
          description: "{{ $value }} errors in last 10 minutes"

      # Alert 8: Slow Recovery
      - alert: SlowServiceRecovery
        expr: recovery_time_ms > 30000
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Slow recovery for {{ $labels.service }}"
          description: "Recovery time is {{ $value }}ms (threshold: 30000ms)"
```

### Alert Notification Channels

Configure notification channels in Prometheus/Alertmanager:

#### Email Notifications

```yaml
global:
  resolve_timeout: 5m

route:
  receiver: 'email'
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h

receivers:
  - name: 'email'
    email_configs:
      - to: 'ops-team@example.com'
        from: 'alertmanager@example.com'
        smarthost: 'smtp.example.com:587'
        auth_username: 'alertmanager@example.com'
        auth_password: 'password'
        headers:
          Subject: 'Fallback Alert: {{ .GroupLabels.alertname }}'
```

#### Slack Notifications

```yaml
receivers:
  - name: 'slack'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
        channel: '#alerts'
        title: 'Fallback Alert'
        text: '{{ .GroupLabels.alertname }}: {{ .CommonAnnotations.description }}'
```

#### PagerDuty Notifications

```yaml
receivers:
  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: 'YOUR_SERVICE_KEY'
        description: '{{ .GroupLabels.alertname }}'
        details:
          firing: '{{ template "pagerduty.default.instances" .Alerts.Firing }}'
```

## Log Monitoring

### Log Aggregation

Use ELK Stack (Elasticsearch, Logstash, Kibana) or similar:

#### Logstash Configuration

```conf
input {
  file {
    path => "/path/to/logs/fallback-*.log"
    start_position => "beginning"
    codec => json
  }
}

filter {
  if [type] == "fallback" {
    mutate {
      add_field => { "[@metadata][index_name]" => "fallback-%{+YYYY.MM.dd}" }
    }
  }
}

output {
  elasticsearch {
    hosts => ["localhost:9200"]
    index => "%{[@metadata][index_name]}"
  }
}
```

#### Kibana Queries

```
# High error rate
severity: "error" AND timestamp: [now-1h TO now]

# Specific service failures
service: "llm" AND errorCategory: "LLM_TIMEOUT"

# Fallback events by user
fallbackType: "RETURN_MESSAGE" | stats count by userId

# Error trends
errorCategory: * | timechart count by errorCategory
```

## Health Check Endpoint

### Endpoint: `/api/health-check`

**Request**:
```bash
curl http://localhost:8080/api/health-check
```

**Response**:
```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "status": "healthy",
  "services": {
    "llm": {
      "status": "healthy",
      "responseTime": 45,
      "lastCheck": "2024-01-15T10:30:45.123Z",
      "availability": 0.988
    },
    "tts": {
      "status": "healthy",
      "responseTime": 32,
      "lastCheck": "2024-01-15T10:30:45.123Z",
      "availability": 0.992
    },
    "brainnn": {
      "status": "degraded",
      "responseTime": 2001,
      "lastCheck": "2024-01-15T10:30:45.123Z",
      "availability": 0.955,
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
    "fallbackRate": 0.012,
    "averageLatency": 28
  }
}
```

## Metrics Endpoint

### Endpoint: `/metrics`

**Request**:
```bash
curl http://localhost:8080/metrics
```

**Response** (Prometheus format):
```
# HELP fallback_total Total number of fallback events
# TYPE fallback_total counter
fallback_total{service="llm",type="timeout"} 42
fallback_total{service="tts",type="error"} 15

# HELP fallback_rate Fallback rate (percentage)
# TYPE fallback_rate gauge
fallback_rate{service="llm"} 0.012
fallback_rate{service="tts"} 0.008

# HELP service_availability Service availability (percentage)
# TYPE service_availability gauge
service_availability{service="llm"} 0.988
service_availability{service="tts"} 0.992
```

## Fallback Stats Endpoint

### Endpoint: `/api/fallback-stats`

**Request**:
```bash
curl http://localhost:8080/api/fallback-stats
```

**Response**:
```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "totalFallbacks": 42,
  "fallbacksByService": {
    "llm": 5,
    "tts": 3,
    "brainnn": 34
  },
  "fallbacksByType": {
    "RETURN_MESSAGE": 8,
    "SKIP_SERVICE": 34
  },
  "fallbacksByErrorCategory": {
    "LLM_TIMEOUT": 3,
    "TTS_ERROR": 2,
    "BRAINNN_TIMEOUT": 34,
    "CONNECTION_REFUSED": 3
  },
  "fallbackRate": 0.012,
  "averageLatency": 28,
  "p95Latency": 42,
  "p99Latency": 48,
  "serviceAvailability": {
    "llm": 0.988,
    "tts": 0.992,
    "brainnn": 0.955
  },
  "recoveryStats": {
    "averageRecoveryTime": 2345,
    "lastRecoveryTime": 1234,
    "totalRecoveries": 8
  }
}
```

## Monitoring Best Practices

### 1. Set Appropriate Alert Thresholds

- **Fallback Rate**: Alert at 5%, critical at 10%
- **Service Availability**: Alert at 95%, critical at 90%
- **Response Time**: Alert at 5s P95, critical at 10s P95
- **Error Rate**: Alert at 1/sec, critical at 5/sec

### 2. Monitor Trends

- Track fallback rate over time
- Identify patterns (time of day, specific services)
- Correlate with deployments or changes

### 3. Set Up Dashboards

- Real-time fallback rate
- Service availability status
- Error distribution
- Recovery metrics

### 4. Configure Alerts

- Critical alerts: Page on-call engineer
- Warning alerts: Create ticket
- Info alerts: Log for analysis

### 5. Regular Review

- Weekly: Review alert trends
- Monthly: Analyze root causes
- Quarterly: Adjust thresholds

## Troubleshooting Monitoring

### Metrics Not Appearing

```bash
# Check if metrics endpoint is working
curl http://localhost:8080/metrics

# Check if Prometheus is scraping
curl http://localhost:9090/api/v1/targets

# Check Prometheus logs
tail -f /var/log/prometheus/prometheus.log
```

### Alerts Not Firing

```bash
# Check alert rules
curl http://localhost:9090/api/v1/rules

# Check alert status
curl http://localhost:9090/api/v1/alerts

# Check Alertmanager
curl http://localhost:9093/api/v1/alerts
```

### Dashboard Not Updating

```bash
# Check Grafana data source
curl http://localhost:3000/api/datasources

# Check query performance
# In Grafana: Inspect → Query Inspector

# Increase refresh interval
# In Grafana: Dashboard settings → Refresh interval
```

## Related Documentation

- [Fallback System Overview](./FALLBACK_SYSTEM.md)
- [Troubleshooting Guide](./FALLBACK_TROUBLESHOOTING.md)
- [Configuration Guide](./.env.example)

</content>
