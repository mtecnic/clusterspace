---
id: feature-development
name: "Feature Development"
category: development
description: "End-to-end feature development workflow from branch creation to merge"
assignedPersonas:
  - builder
  - reviewer
  - tester
successCriteria: "Feature merged to main with passing tests and approved review"
---

## Overview

This task template guides the development of a new feature from initial branch creation through to merge.

## Steps

### Step 1: Create Feature Branch

**Action**: Create and checkout a new feature branch from main

```bash
git checkout main
git pull origin main
git checkout -b feature/FEATURE_NAME
```

**Success Criteria**: On new branch, main is up to date

### Step 2: Implement Feature

**Action**: Write the code for the feature

- Create/modify necessary files
- Follow existing code patterns
- Include error handling

**Success Criteria**: Feature code complete, no syntax errors

### Step 3: Add Tests

**Action**: Write tests for the new functionality

```bash
# Add unit tests
# Add integration tests if needed
npm test
```

**Success Criteria**: Tests written and passing locally

### Step 4: Run Full Test Suite

**Action**: Ensure no regressions

```bash
npm run test:all
npm run lint
npm run build
```

**Success Criteria**: All tests pass, no lint errors, build succeeds

### Step 5: Code Review

**Action**: Have code reviewed by reviewer agent

- Check code quality
- Verify test coverage
- Review for security issues

**Success Criteria**: Review approved or issues addressed

### Step 6: Merge to Main

**Action**: Merge the feature branch

```bash
git checkout main
git pull origin main
git merge feature/FEATURE_NAME
git push origin main
```

**Success Criteria**: Feature merged, CI pipeline passes

## Notes

- Each step should use declare_step/verify_step protocol
- Builder handles steps 1-4
- Reviewer handles step 5
- Tester validates step 4
- Builder completes step 6
