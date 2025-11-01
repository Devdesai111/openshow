Following the structured plan and moving into the critical area of operational documentation, we proceed with **Task 91: Observability Dashboards & Runbooks**.

This task is focused on defining the administrative tools and documentation necessary for the operations team to quickly assess system health and respond effectively to incidents, relying on the metrics (Task 75) and logging (Task 76) infrastructure.

***

## **Task 91: Observability Dashboards & Runbooks**

**Goal:** Define the structure and content for essential operational runbooks (e.g., for a payment failure incident) and specify the minimum set of real-time monitoring dashboards (leveraging Prometheus/Grafana concept from Task 75).

**Service:** `Deployment / Infrastructure` (Operational Documentation)
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 75 (Metrics), Task 76 (Logging/Tracing), Task 82 (Circuit Breaker).

**Output Files:**
1.  `documentation/runbooks/payment_failure_incident.md` (New file: Example Incident Response)
2.  `documentation/observability_dashboards.json` (New file: Dashboard variable/panel specification)

**Input/Output Shapes:**

| Document | Purpose | Key Metric/Component | Target User |
| :--- | :--- | :--- | :--- |
| **Runbook** | Incident recovery guide. | Circuit Breaker status, DLQ check. | On-Call Engineer |
| **Dashboard Spec** | Real-time system health visualization. | SLO compliance, Error rate/latency (p95). | Operations/SRE |

**Runtime & Env Constraints:**
*   Documentation must be actionable, clear, and specifically reference the components implemented in prior tasks (e.g., `JobService.getJobStatus`).
*   The runbook must guide the engineer to check the **traceId** (Task 76) for deep investigation.

**Acceptance Criteria:**
*   The Runbook includes steps for immediate mitigation (e.g., toggling a feature flag/resetting a circuit breaker).
*   The Dashboard specification defines panels for all critical flows: Auth, Payments, and Jobs.
*   The documentation clearly links observable failure states (e.g., Payout failure) to actionable administrative steps (e.g., checking the DLQ).

**Tests to Generate:**
*   **Documentation:** The defined documentation files themselves.

***

### **Task 91 Code Implementation (Documentation Specification)**

#### **91.1. `documentation/observability_dashboards.json` (New Dashboard Spec)**

```json
{
  "dashboard_name": "OpenShow - Production Overview",
  "data_source": "Prometheus (Task 75 Metrics)",
  "panels": [
    {
      "title": "A1. Global Application Health & Errors",
      "type": "Graph",
      "metrics": [
        "sum(rate(http_requests_total{status!='200',status!='401'}[5m])) by (status)",
        "avg(http_request_duration_seconds{path=~'/auth/login'}[5m])"
      ],
      "description": "Total non-auth/non-200 error rate by status code."
    },
    {
      "title": "A2. Service SLO Compliance (p95 Latency)",
      "type": "Gauge/Heatmap",
      "metrics": [
        "histogram_quantile(0.95, sum by (path, le) (rate(http_request_duration_seconds_bucket[5m])) )"
      ],
      "filter_paths": ["/creators", "/auth/me", "/payments/intents"],
      "slo_target_ms": 100
    },
    {
      "title": "B1. Payments & Escrow State",
      "type": "Stat/Table",
      "metrics": [
        "sum(app_active_escrows{status='locked'})",
        "sum(app_active_escrows{status='disputed'})",
        "sum(app_active_jobs_count{type='payout.execute'})"
      ],
      "description": "Monitors funds-at-risk and payout queue depth."
    },
    {
      "title": "B2. Job Queue Health & DLQ",
      "type": "Table",
      "metrics": [
        "sum(app_jobs_total{status='queued'}) by (type)",
        "sum(app_jobs_total{status='dlq'})"
      ],
      "description": "Total queued jobs by type and Dead Letter Queue depth."
    }
  ]
}
```

#### **91.2. `documentation/runbooks/payment_failure_incident.md` (New Runbook)**

```markdown
# Runbook: Payments Service Outage (Circuit Breaker Tripped)

**Incident Title:** Payments API Responding with 503 Service Unavailable / Payment Intent Creation Failure (424).
**Trigger:** Alert on `http_requests_total` for path `/payments/intents` showing 503 status code OR frequent 424 errors (Task 82).
**Priority:** P1 (CRITICAL) - Direct financial impact.

---

## 1. Initial Triage (5 minutes)

1.  **Check Metrics:** Confirm the `/payments/intents` latency and error rate (Panel A2).
2.  **Check Logs:** Search ELK/Splunk for recent `error` logs using the pattern: `message: "CircuitOpen"` (503) or `message: "FailedDependency"` (424) to confirm the circuit breaker state.
3.  **Confirm Status:** Verify the external PSP's (Stripe/Razorpay) status page for a known outage.

## 2. Mitigation and Recovery (10 minutes)

### A. Immediate Mitigation (If Circuit is OPEN)

1.  **Objective:** Move the circuit to HALF-OPEN to allow a test call, or manually reset.
2.  **Action 1 (Manual Reset - High Risk):**
    *   **Admin API:** Call the internal Admin endpoint to reset the circuit breaker state.
    *   `POST /admin/payments/circuit-breaker/reset` (Requires FINANACE_MANAGE perm).
3.  **Action 2 (Temporary Feature Toggle - Low Risk):**
    *   Toggle a feature flag in the config service (Future Task 94) to redirect payment intent creation to a secondary/failover PSP adapter.

### B. Deep Investigation (If 424 Errors Persist)

1.  **Identify Trace ID:** Find a recent transaction failure log and copy the `traceId` (Task 76).
2.  **Audit Check:** Search the **Audit Logs** (`GET /admin/audit-logs`, Task 61) using the `traceId` to find the corresponding `payment.intent.created` event.
3.  **Check Dependent Services:** Verify the health of the Project Service (`GET /health`, Task 7) and the Job Service (Panel B2).

## 3. Resolution

1.  If external PSP is confirmed healthy, complete the manual reset (Step 2A).
2.  If mitigation succeeds, update the circuit breaker configuration to increase the `resetTimeoutMs` (Task 82) for better stability in the future.
```

---

