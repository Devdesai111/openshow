Following the structured plan and focusing on extreme operational resilience, we proceed with **Task 99: Platform Hardening & Backup Strategy**.

This task specifies the essential, high-level procedures for safeguarding the production environment, covering data integrity, disaster recovery, and the proactive measures for system resilience.

***

## **Task 99: Platform Hardening & Backup Strategy**

**Goal:** Define the final operational procedures for database backup (Point-in-Time Recovery), security hardening (Network ACLs), and a full Disaster Recovery (DR) plan, ensuring maximum data integrity and minimal recovery time objectives (RTOs).

**Service:** `Deployment / Infrastructure`
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** All infrastructure tasks (T60, T77, T79).

**Output Files:**
1.  `documentation/dr_backup_plan.md` (New file: Procedures for resilience)
2.  `scripts/backup_cli.sh` (New file: Conceptual database backup script)

**Input/Output Shapes:**

| Procedure | Tool/Action | RTO/RPO | Security Principle |
| :--- | :--- | :--- | :--- |
| **Backup Strategy** | MongoDB Cloud Manager/Ops Manager. | **RPO $\le 5$ min** (Point-in-Time Recovery). | Encryption at rest and in transit. |
| **Network Hardening**| AWS/GCP Security Groups/VPC ACLs. | Block all ingress except Gateway/Admin/Health probes. | Least privilege network access. |

**Runtime & Env Constraints:**
*   **Automation:** Backups must be fully automated and regularly tested.
*   **Security:** Network Access Control Lists (ACLs) must be defined to enforce strict separation between microservice layers and external access points.

**Acceptance Criteria:**
*   The backup strategy defines a clear Recovery Point Objective (RPO) and Recovery Time Objective (RTO).
*   The hardening section explicitly mentions the enforcement of network ACLs to protect database instances and internal microservice communication.
*   The CLI script demonstrates the concept of an automated, time-stamped backup process.

**Tests to Generate:**
*   **Documentation:** The defined DR and backup procedure documents.

***

### **Task 99 Code Implementation (Documentation & Strategy)**

#### **99.1. `documentation/dr_backup_plan.md` (New DR/Backup Doc)**

```markdown
# Disaster Recovery and Backup Strategy (MongoDB & Microservices)

This document outlines the mandatory procedures for backup, recovery, and security hardening of the OpenShow production environment.

## 1. Data Backup Strategy (MongoDB)

| Metric | Target | Rationale |
| :--- | :--- | :--- |
| **RPO (Recovery Point Objective)**| **< 5 minutes** | Achieved via **Point-in-Time Recovery** (PITR) with MongoDB Ops/Cloud Manager or a dedicated WAL (Write-Ahead Log) backup strategy. |
| **RTO (Recovery Time Objective)**| **< 60 minutes** | Achieved via automated cluster deployment templates (IaC) and pre-warmed standby nodes. |
| **Backup Frequency** | Continuous Incremental + Daily Full Snapshot. | |
| **Storage:** | Immutable, geographically separate S3 bucket with 90-day retention. | Encrypted with KMS (Task 74). |

## 2. Platform Hardening (Network & Access)

| Component | Policy | Enforcement Method |
| :--- | :--- | :--- |
| **Database Cluster** | **Block All Ingress** except from Microservice Subnet and Admin Subnet (VPN). | VPC Security Group Egress/Ingress Rules. |
| **Microservices (Internal)**| Block all ingress except from **API Gateway** (Load Balancer) and **Internal Service Mesh**. | Service Mesh Policy (e.g., Istio/Linkerd) or Security Group ACLs. |
| **Admin Endpoints** | Only accessible via a dedicated, IP-whitelisted Admin Subnet or requires Admin MFA (Task 73). | Gateway routing + WAF/Security Group. |
| **Secrets/Keys (T74)** | Mandatory key rotation every 90 days. | Automated KMS/Vault rotation policy. |

## 3. Disaster Recovery Procedures

1.  **Failover:** Automated replica set election (RPO compliance).
2.  **Restore:** In case of data corruption, provision a new cluster, restore the last clean snapshot + WAL up to the target timestamp.
3.  **App Restart:** Microservices are re-deployed/re-pointed to the new cluster via automated IaC pipeline (Task 77).
```

#### **99.2. `scripts/backup_cli.sh` (Conceptual Backup Script)**

```bash
#!/bin/bash
# scripts/backup_cli.sh
set -e

BACKUP_DIR="/mnt/mongodb/backup"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DB_NAME=${DB_NAME:-"openshow_db"}

echo "--- Starting Automated MongoDB Backup ---"

# 1. Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

# 2. Run mongodump for a full snapshot (CRITICAL: In prod, use oplog for PITR)
echo "Dumping database $DB_NAME..."
/usr/bin/mongodump --uri="$MONGODB_URL" \
                   --db="$DB_NAME" \
                   --out="$BACKUP_DIR/full_snapshot_$TIMESTAMP" \
                   --gzip

# Check exit status of mongodump
if [ $? -ne 0 ]; then
    echo "ERROR: mongodump failed!"
    exit 1
fi

# 3. Simulate encryption and secure cloud upload
echo "Encrypting and uploading to S3..."
# In reality, this would use KMS and an S3 SDK client
# aws s3 cp "$BACKUP_DIR/full_snapshot_$TIMESTAMP" s3://openshow-backup-us-east-1/ --sse aws:kms

echo "Backup completed successfully for snapshot: full_snapshot_$TIMESTAMP"
```

#### **99.3. Test Specification**

| Test ID | Method | Description | Tool | Expected Check |
| :--- | :--- | :--- | :--- | :--- |
| **T99.1** | `CLI Script` | Backup Execution | `backup_cli.sh` | Dump file created in mock directory. |
| **T99.2** | `DR Plan Check` | RTO/RPO Compliance | N/A | Documentation confirms PITR strategy for RPO < 5 min. |
| **T99.3** | `Hardening Check`| Network Integrity | N/A | Documentation confirms DB ingress is restricted by security groups. |

---