---
id: deployment
name: "Application Deployment"
category: operations
description: "Deploy application to target environment with verification"
assignedPersonas:
  - admin
  - monitor
successCriteria: "Application deployed and healthy in target environment"
---

## Overview

This task template guides the deployment of an application to a target environment with proper verification.

## Steps

### Step 1: Pre-Deployment Checks

**Action**: Verify environment and current state

```bash
# Verify target environment
echo $DEPLOY_ENV
kubectl config current-context

# Check current state
kubectl get pods
docker ps

# Verify build artifacts exist
ls -la dist/
```

**Success Criteria**: Correct environment confirmed, artifacts ready

### Step 2: Backup Current State

**Action**: Create backup/snapshot of current deployment

```bash
# For Kubernetes
kubectl get deployment app -o yaml > backup-deployment.yaml

# For Docker
docker commit container_name backup_image

# Database backup if needed
pg_dump dbname > backup.sql
```

**Success Criteria**: Backup created and verified

### Step 3: Deploy Application

**Action**: Execute the deployment

```bash
# Docker Compose
docker-compose pull
docker-compose up -d

# Kubernetes
kubectl apply -f deployment.yaml
kubectl rollout status deployment/app

# PM2
pm2 reload ecosystem.config.js
```

**Success Criteria**: Deployment command completes without errors

### Step 4: Health Verification

**Action**: Verify application is healthy

```bash
# Wait for startup
sleep 10

# Check health endpoint
curl -s http://localhost:3000/health

# Check logs for errors
docker logs --tail 50 container_name
kubectl logs -l app=myapp --tail=50
```

**Success Criteria**: Health check passes, no errors in logs

### Step 5: Smoke Tests

**Action**: Run basic functionality tests

```bash
# Test critical endpoints
curl -s http://localhost:3000/api/status
curl -s http://localhost:3000/api/users

# Run smoke test suite
npm run test:smoke
```

**Success Criteria**: All smoke tests pass

### Step 6: Monitor for Issues

**Action**: Watch for problems in first 5 minutes

```bash
# Watch logs
tail -f /var/log/app.log

# Monitor resources
docker stats

# Check error rates
# (implementation specific)
```

**Success Criteria**: No errors in monitoring period

## Rollback Plan

If deployment fails:

```bash
# Docker Compose
docker-compose down
docker-compose -f backup-compose.yaml up -d

# Kubernetes
kubectl rollout undo deployment/app

# Restore backup
kubectl apply -f backup-deployment.yaml
```

## Notes

- Admin handles steps 1-5
- Monitor handles step 6
- Both verify each step
- Keep rollback commands ready at all times
