Following the structured plan and moving into the critical area of non-functional requirements, we proceed with **Task 85: Load & Performance Testing Scenarios**.

This task specifies the essential load testing scenarios that must be executed to ensure the platform can handle expected production traffic, focusing on the most performance-sensitive and resource-intensive endpoints.

***

## **Task 85: Load & Performance Testing Scenarios**

**Goal:** Define the critical load testing scenarios (user volume, target APIs, and acceptable latency/throughput thresholds) to validate the system's performance, scalability, and resilience before production launch.

**Service:** `Quality Assurance` (Non-Functional Testing)
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 80 (Caching), Task 79 (Indexing), Task 75 (Metrics).

**Output Files:**
1.  `config/loadtests/scenarios.json` (New file: Definition of test plans)
2.  `documentation/performance_targets.md` (New file: Performance requirements document)
3.  `test/load/k6-script-conceptual.js` (Conceptual k6/JMeter script outline)

**Input/Output Shapes (Target SLOs - Service Level Objectives):**

| Scenario | Target RPS (Reads) | Target RPS (Writes) | Latency Goal (p95) | Critical Component Test |
| :--- | :--- | :--- | :--- | :--- |
| **A: Discovery/Marketplace** | 200 RPS | 0 RPS | $\le 50$ms | Caching (T80), Indexing (T79/41) |
| **B: Authenticated Read** | 50 RPS | 0 RPS | $\le 100$ms | JWT Auth, DB Lookup (`GET /auth/me`, `GET /projects`) |
| **C: High-Contention Write** | 0 RPS | 5 RPS | $\le 200$ms | DB Transaction (`POST /projects`, `POST /auth/signup`) |
| **D: Critical Write Flow** | 0 RPS | 1 RPS | $\le 500$ms | Escrow Lock/Release (`POST /payments/escrow/release`) |

**Runtime & Env Constraints:**
*   Tests must be run against a staging environment that mirrors the production infrastructure (e.g., clustered MongoDB, clustered Redis/mock cache).
*   Test volume should simulate peak traffic (e.g., 200 concurrent VUs for 10 minutes).
*   Metrics must be collected via Prometheus/Grafana (Task 75).

**Acceptance Criteria:**
*   The system successfully handles the Load Test with no errors (status code $\ge 400$).
*   Latency for all defined critical endpoints meets the specified p95 SLOs.
*   Database CPU/IO utilization remains below a defined safe threshold (e.g., $\le 70\%$).

**Tests to Generate:**
*   **Documentation:** `scenarios.json` and `performance_targets.md`.

***

### **Task 85 Code Implementation (Documentation & Scenario Definition)**

#### **85.1. `config/loadtests/scenarios.json` (New Test Plan Definition)**

```json
{
  "project_name": "OpenShow AI Creator Collaboration",
  "test_tool": "k6/JMeter",
  "staging_url": "https://api.staging.openshow.com",
  "global_vus": 200,
  "global_duration": "10m",
  
  "scenarios": [
    {
      "name": "S_01_Discovery_Read_Heavy",
      "type": "Spike/Stress",
      "target_vus": 150,
      "endpoints": [
        { 
          "path": "/api/v1/creators", 
          "method": "GET", 
          "weight": 60,
          "params": ["q=video&verified=true", "skill=prompt-engineer"],
          "slo_p95_ms": 50
        },
        { 
          "path": "/api/v1/search/suggestions", 
          "method": "GET", 
          "weight": 40,
          "params": ["q=promp"],
          "slo_p95_ms": 30
        }
      ]
    },
    {
      "name": "S_02_Auth_Profile_Read",
      "type": "Load/Soak",
      "target_vus": 50,
      "endpoints": [
        { "path": "/api/v1/auth/me", "method": "GET", "weight": 70, "slo_p95_ms": 100 },
        { "path": "/api/v1/projects", "method": "GET", "weight": 30, "slo_p95_ms": 150 }
      ]
    },
    {
      "name": "S_03_Critical_Write_Contention",
      "type": "Contention/Stress",
      "target_vus": 10,
      "endpoints": [
        { 
          "path": "/api/v1/auth/signup", 
          "method": "POST", 
          "weight": 30, 
          "slo_p95_ms": 250, 
          "data_type": "unique_email" 
        },
        { 
          "path": "/api/v1/projects", 
          "method": "POST", 
          "weight": 70, 
          "slo_p95_ms": 350, 
          "data_type": "unique_project" 
        }
      ]
    }
  ]
}
```

#### **85.2. `documentation/performance_targets.md` (New Requirements Doc)**

```markdown
# Performance and Scalability Requirements (SLOs)

This document defines the Service Level Objectives (SLOs) that the OpenShow backend must meet under projected peak load (200 concurrent Virtual Users).

## 1. Latency Targets (p95)

| Endpoint Group | Critical Endpoint | SLO (p95) | Test Scenario | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Discovery/Search** | `GET /creators` | **50 ms** | S_01 | Highly dependent on Caching (Task 80) and Indexing (Task 79). |
| **Auth Read** | `GET /auth/me` | **100 ms** | S_02 | Must be fast DB read (Task 79 indexing/caching). |
| **Project Read** | `GET /projects/:id` | **150 ms** | S_02 | Involves multiple DB lookups (Project + Sub-docs). |
| **Project Write** | `POST /projects` | **350 ms** | S_03 | Requires multiple DB inserts and pre-save validation. |
| **Critical Financial** | `POST /payments/escrow/release` | **500 ms** | S_04 (Future) | Involves orchestration, external PSP calls, and multiple DB updates. |

## 2. Resource Utilization Limits

*   **Database CPU:** Must remain below **70%** under peak load.
*   **API CPU:** Average CPU utilization across the API cluster must be below **80%**.
*   **Error Rate:** Non-operational error rate (4xx/5xx) must be $\le \mathbf{0.01\%}$ of total requests.

## 3. Resilience and Failover

*   **Circuit Breaker (T82):** Must demonstrate a successful trip and recovery (CLOSED $\rightarrow$ OPEN $\rightarrow$ HALF-OPEN $\rightarrow$ CLOSED) without causing internal service timeouts.
*   **Database (T79):** The system must remain operational under read load when simulating the failure of a secondary MongoDB replica node.
```

---