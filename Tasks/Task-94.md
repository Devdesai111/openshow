Following the structured plan and focusing on runtime configuration and experimentation, we proceed with **Task 94: Feature Flags & Config Service Integration**.

This task implements the mechanism for managing configuration and feature toggles at runtime, which is essential for safely deploying new features, controlling rollouts, and running A/B tests.

***

## **Task 94: Feature Flags & Config Service Integration**

**Goal:** Implement a centralized `ConfigService` utility that simulates retrieving and caching feature flag states and configuration variables from an external store, allowing services to check if a feature is enabled at runtime.

**Service:** `Utility & System Features` (Foundation)
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 74 (Secrets/Config structure).

**Output Files:**
1.  `src/config/featureFlags.ts` (New file: Feature flag definitions)
2.  `src/utils/configProvider.utility.ts` (New file: Feature flag and config service mock)
3.  `test/unit/feature_flag.test.ts` (Test specification)

**Input/Output Shapes:**

| Utility Action | Input | Output | Principle |
| :--- | :--- | :--- | :--- |
| **isFeatureEnabled** | `flagKey: string, userId: string` | `boolean` | Rollout management (User/Tenant targeting). |
| **getConfigValue** | `configKey: string` | `string` | Central source of truth for runtime settings. |

**Runtime & Env Constraints:**
*   **Performance (CRITICAL):** Flag lookups must be fast; logic assumes a cached in-memory store.
*   **Targeting:** The system must conceptually support user-level (or segment/tenant-level) targeting for gradual rollouts.

**Acceptance Criteria:**
*   The `isFeatureEnabled` utility correctly returns `true` for a globally enabled feature.
*   The system successfully simulates a user being excluded from a rollout (e.g., a flag is `false` for 50% of users).
*   The logic is structured to easily integrate with external services like LaunchDarkly or Unleash in the future.

**Tests to Generate:**
*   **Unit Test (Rollout):** Test a flag enabled for 50% of users and verify results for two different mock user IDs (one passes, one fails).
*   **Unit Test (Global Config):** Test retrieving a global setting.

***

### **Task 94 Code Implementation**

#### **94.1. `src/config/featureFlags.ts` (New Config File)**

```typescript
// src/config/featureFlags.ts
import { IAuthUser } from '../middlewares/auth.middleware';

export type UserContext = Pick<IAuthUser, 'sub' | 'role' | 'tenantId'>;

// Define all features that can be toggled
export const FEATURES = {
    // Financial Features
    PAYOUT_BATCHING_ENABLED: 'payout_batching_enabled',
    HIGH_VALUE_REFUND_APPROVAL: 'high_value_refund_approval',
    
    // UI/UX Features
    CREATOR_PROFILE_V2: 'creator_profile_v2',
    
    // Infrastructure Features
    VECTOR_SEARCH_ENABLED: 'vector_search_enabled', // Task 45
};

// Define the structure for a flag policy
export interface IFlagPolicy {
    description: string;
    globalDefault: boolean;
    rolloutPercentage?: number; // 0-100
    // Future: roleTargeting?: string[];
    // Future: userIncludeList?: string[];
}
```

#### **94.2. `src/utils/configProvider.utility.ts` (New Utility File - Flag/Config Mock)**

```typescript
// src/utils/configProvider.utility.ts
import { FEATURES, IFlagPolicy, UserContext } from '../config/featureFlags';

// Mock Config Store (Simulated DB/LaunchDarkly Cache)
const flagStore: Record<string, IFlagPolicy> = {
    [FEATURES.PAYOUT_BATCHING_ENABLED]: { 
        description: 'Enables grouping payouts into batches.', 
        globalDefault: true 
    },
    [FEATURES.CREATOR_PROFILE_V2]: { 
        description: 'New creator profile UI.', 
        globalDefault: false,
        rolloutPercentage: 50 // 50% A/B test
    },
    // ... add all flags from FEATURES
};

// Mock Global Configs
const globalConfigs: Record<string, string> = {
    SUPPORT_EMAIL: 'support@openshow.com',
    DEFAULT_CURRENCY: 'USD',
};

/**
 * Utility to manage and check feature flag states and global configuration.
 */
export class ConfigProvider {
    
    /**
     * Checks if a feature flag is enabled for the given user context.
     * @param flagKey - The feature flag identifier.
     * @param context - The user context (ID, Role, Tenant) for targeting.
     * @returns True if the feature is enabled.
     */
    public static isFeatureEnabled(flagKey: string, context: UserContext): boolean {
        const policy = flagStore[flagKey];
        if (!policy) {
            console.warn(`[Config] Feature flag ${flagKey} not found. Defaulting to false.`);
            return false;
        }

        // 1. Global Default Check
        if (policy.globalDefault === true && !policy.rolloutPercentage) {
            return true;
        }

        // 2. Rollout Percentage Check (Simplified Consistent Hashing)
        if (policy.rolloutPercentage) {
            // Hashing the unique user ID to a number between 0 and 99
            const hash = crypto.createHash('sha256').update(context.sub).digest('hex');
            const userRolloutNumber = parseInt(hash.substring(0, 2), 16) % 100;
            
            return userRolloutNumber < policy.rolloutPercentage;
        }

        // Final Default
        return policy.globalDefault;
    }

    /** Retrieves a global configuration value. */
    public static getConfigValue(configKey: string): string | null {
        return globalConfigs[configKey] || null;
    }
}
```

#### **94.3. Test Specification**

| Test ID | Method | Description | Flag State | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **T94.1** | `isFeatureEnabled` | Global ON Check | `PAYOUT_BATCHING_ENABLED` (Default: True, No rollout) | `true` |
| **T94.2** | `isFeatureEnabled` | Global OFF Check | `VECTOR_SEARCH_ENABLED` (Default: False) | `false` |
| **T94.3** | `isFeatureEnabled` | Rollout ON Check | `CREATOR_PROFILE_V2` (Rollout: 50%) with a mock ID that hashes to $< 50$. | `true` |
| **T94.4** | `isFeatureEnabled` | Rollout OFF Check | `CREATOR_PROFILE_V2` (Rollout: 50%) with a mock ID that hashes to $\ge 50$. | `false` |
| **T94.5** | `getConfigValue` | Global Config Retrieval | `DEFAULT_CURRENCY` | Returns `'USD'`. |

---
