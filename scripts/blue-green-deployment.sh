#!/bin/bash
# Blue-Green Deployment Script for Memory Suite
# 
# This script implements a blue-green deployment strategy for zero-downtime deployments
# Usage: ./blue-green-deployment.sh [action] [options]
# 
# Actions:
#   deploy    - Deploy to green environment and switch traffic
#   rollback  - Rollback to blue environment
#   status    - Show current deployment status
#   validate  - Validate green environment before cutover

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
BLUE_ENVIRONMENT="blue"
GREEN_ENVIRONMENT="green"
CURRENT_ENVIRONMENT_FILE="$PROJECT_ROOT/.current-environment"
DEPLOYMENT_LOG="$PROJECT_ROOT/deployment-$(date +%Y%m%d-%H%M%S).log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$DEPLOYMENT_LOG"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" | tee -a "$DEPLOYMENT_LOG"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "$DEPLOYMENT_LOG"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$DEPLOYMENT_LOG"
}

# Get current active environment
get_current_environment() {
    if [ -f "$CURRENT_ENVIRONMENT_FILE" ]; then
        cat "$CURRENT_ENVIRONMENT_FILE"
    else
        echo "$BLUE_ENVIRONMENT"
    fi
}

# Set current active environment
set_current_environment() {
    echo "$1" > "$CURRENT_ENVIRONMENT_FILE"
}

# Get standby environment
get_standby_environment() {
    local current=$(get_current_environment)
    if [ "$current" = "$BLUE_ENVIRONMENT" ]; then
        echo "$GREEN_ENVIRONMENT"
    else
        echo "$BLUE_ENVIRONMENT"
    fi
}

# Check if Docker is running
check_docker() {
    log_info "Checking Docker..."
    if ! docker info > /dev/null 2>&1; then
        log_error "Docker is not running"
        exit 1
    fi
    log_success "Docker is running"
}

# Deploy to green environment
deploy_to_green() {
    local standby=$(get_standby_environment)
    log_info "Deploying to $standby environment..."
    
    # Build services
    log_info "Building services..."
    docker-compose build --parallel 2>&1 | tee -a "$DEPLOYMENT_LOG"
    log_success "Services built"
    
    # Start services
    log_info "Starting services..."
    docker-compose up -d 2>&1 | tee -a "$DEPLOYMENT_LOG"
    log_success "Services started"
    
    # Wait for services to be ready
    log_info "Waiting for services to be ready..."
    sleep 10
    
    # Verify services are healthy
    log_info "Verifying service health..."
    if ! verify_service_health; then
        log_error "Service health check failed"
        return 1
    fi
    
    log_success "Services are healthy"
    return 0
}

# Verify service health
verify_service_health() {
    local max_attempts=30
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        local decision_health=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/health || echo "000")
        local generation_health=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8082/health || echo "000")
        local manager_health=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health || echo "000")
        
        if [ "$decision_health" = "200" ] && [ "$generation_health" = "200" ] && [ "$manager_health" = "200" ]; then
            log_success "All services are healthy"
            return 0
        fi
        
        log_info "Waiting for services... (attempt $((attempt + 1))/$max_attempts)"
        sleep 2
        attempt=$((attempt + 1))
    done
    
    log_error "Services did not become healthy within timeout"
    return 1
}

# Run validation tests
run_validation_tests() {
    log_info "Running validation tests..."
    
    # Run staging deployment validation
    if ! npx ts-node "$SCRIPT_DIR/staging-deployment-validation.ts"; then
        log_error "Validation tests failed"
        return 1
    fi
    
    log_success "Validation tests passed"
    return 0
}

# Switch traffic to green
switch_traffic_to_green() {
    local current=$(get_current_environment)
    local standby=$(get_standby_environment)
    
    log_info "Switching traffic from $current to $standby..."
    
    # Update load balancer configuration
    # This is a placeholder - actual implementation depends on your load balancer
    log_info "Updating load balancer configuration..."
    
    # Update DNS or load balancer to point to green
    # Example: aws elb set-load-balancer-listener-ssl-certificate ...
    
    # Wait for DNS propagation
    log_info "Waiting for DNS propagation..."
    sleep 5
    
    # Verify traffic is flowing to new environment
    log_info "Verifying traffic flow..."
    if ! verify_traffic_flow "$standby"; then
        log_error "Traffic verification failed"
        return 1
    fi
    
    # Update current environment
    set_current_environment "$standby"
    log_success "Traffic switched to $standby"
    return 0
}

# Verify traffic is flowing correctly
verify_traffic_flow() {
    local environment=$1
    local max_attempts=10
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        local response=$(curl -s -w "\n%{http_code}" http://localhost:8080/health)
        local http_code=$(echo "$response" | tail -n1)
        
        if [ "$http_code" = "200" ]; then
            log_success "Traffic is flowing correctly"
            return 0
        fi
        
        log_info "Waiting for traffic flow... (attempt $((attempt + 1))/$max_attempts)"
        sleep 2
        attempt=$((attempt + 1))
    done
    
    log_error "Traffic verification failed"
    return 1
}

# Monitor deployment
monitor_deployment() {
    log_info "Monitoring deployment for 5 minutes..."
    
    local start_time=$(date +%s)
    local duration=300  # 5 minutes
    
    while true; do
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))
        
        if [ $elapsed -ge $duration ]; then
            break
        fi
        
        # Check error rate
        local error_rate=$(curl -s http://localhost:9090/api/v1/query?query='rate(http_requests_total{status=~"5.."}[1m])' | grep -o '"value":\[[^]]*\]' | head -1 || echo "0")
        
        # Check response time
        local response_time=$(curl -s http://localhost:9090/api/v1/query?query='histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[1m]))' | grep -o '"value":\[[^]]*\]' | head -1 || echo "0")
        
        log_info "Monitoring... Error Rate: $error_rate, Response Time: $response_time"
        
        sleep 10
    done
    
    log_success "Monitoring completed"
}

# Rollback to previous environment
rollback_deployment() {
    local current=$(get_current_environment)
    local previous=$(get_standby_environment)
    
    log_warning "Rolling back from $current to $previous..."
    
    # Switch traffic back
    log_info "Switching traffic back to $previous..."
    
    # Update load balancer to point back to previous environment
    # This is a placeholder - actual implementation depends on your load balancer
    
    # Wait for DNS propagation
    sleep 5
    
    # Verify traffic is flowing to previous environment
    if ! verify_traffic_flow "$previous"; then
        log_error "Rollback verification failed"
        return 1
    fi
    
    # Update current environment
    set_current_environment "$previous"
    log_success "Rolled back to $previous"
    return 0
}

# Show deployment status
show_status() {
    local current=$(get_current_environment)
    local standby=$(get_standby_environment)
    
    log_info "Current Deployment Status"
    log_info "========================="
    log_info "Active Environment: $current"
    log_info "Standby Environment: $standby"
    
    # Check service health
    log_info ""
    log_info "Service Health:"
    
    local decision_health=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/health || echo "000")
    local generation_health=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8082/health || echo "000")
    local manager_health=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health || echo "000")
    
    if [ "$decision_health" = "200" ]; then
        log_success "Decision Service: Healthy"
    else
        log_error "Decision Service: Unhealthy (HTTP $decision_health)"
    fi
    
    if [ "$generation_health" = "200" ]; then
        log_success "Generation Service: Healthy"
    else
        log_error "Generation Service: Unhealthy (HTTP $generation_health)"
    fi
    
    if [ "$manager_health" = "200" ]; then
        log_success "Web Manager: Healthy"
    else
        log_error "Web Manager: Unhealthy (HTTP $manager_health)"
    fi
}

# Validate green environment
validate_green() {
    log_info "Validating green environment..."
    
    if ! run_validation_tests; then
        log_error "Green environment validation failed"
        return 1
    fi
    
    log_success "Green environment is ready for cutover"
    return 0
}

# Main deployment flow
deploy() {
    log_info "Starting blue-green deployment..."
    log_info "Deployment log: $DEPLOYMENT_LOG"
    
    # Check prerequisites
    check_docker
    
    # Deploy to green
    if ! deploy_to_green; then
        log_error "Deployment to green environment failed"
        exit 1
    fi
    
    # Run validation tests
    if ! run_validation_tests; then
        log_error "Validation tests failed"
        exit 1
    fi
    
    # Ask for confirmation before switching traffic
    log_warning "Ready to switch traffic to green environment"
    read -p "Continue with traffic switch? (yes/no): " -r
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warning "Deployment cancelled by user"
        exit 0
    fi
    
    # Switch traffic
    if ! switch_traffic_to_green; then
        log_error "Traffic switch failed"
        exit 1
    fi
    
    # Monitor deployment
    monitor_deployment
    
    log_success "Blue-green deployment completed successfully!"
}

# Print usage
print_usage() {
    echo "Usage: $0 [action] [options]"
    echo ""
    echo "Actions:"
    echo "  deploy    - Deploy to green environment and switch traffic"
    echo "  rollback  - Rollback to previous environment"
    echo "  status    - Show current deployment status"
    echo "  validate  - Validate green environment before cutover"
    echo ""
    echo "Examples:"
    echo "  $0 deploy"
    echo "  $0 rollback"
    echo "  $0 status"
    echo "  $0 validate"
}

# Main script
main() {
    local action=${1:-status}
    
    case $action in
        deploy)
            deploy
            ;;
        rollback)
            rollback_deployment
            ;;
        status)
            show_status
            ;;
        validate)
            validate_green
            ;;
        *)
            print_usage
            exit 1
            ;;
    esac
}

main "$@"
