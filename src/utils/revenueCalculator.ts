// src/utils/revenueCalculator.ts
import { IRevenueSplit } from '../models/project.model';

// DTOs for calculation inputs/outputs
interface ICalculationInput {
  amount: number; // In smallest unit (cents/paise)
  splits: IRevenueSplit[];
}
interface IRecipientShare {
  recipientId?: string;
  placeholder?: string;
  grossShare: number;
  platformFeeShare: number;
  netAmount: number;
}
export interface ICalculationOutput {
  grossAmount: number;
  platformFee: number;
  taxWithheld: number;
  totalDistributed: number;
  breakdown: IRecipientShare[];
}

// Global Fee/Tax Constants (Configurable in a real service)
const PLATFORM_FEE_PERCENT = 5; // 5.0%
// const TAX_WITHHOLDING_PERCENT = 0; // 0% for Phase 1 simplicity (Task 32 can add this)

/**
 * Distributes residual cents deterministically (Largest Remainder Method, Hamilton Method).
 * @param cents - The total number of residual cents to distribute.
 * @param shares - Array of recipient shares (must be non-integer parts).
 */
function distributeResidualCents(
  cents: number,
  shares: { recipient: string; fractional: number }[]
): Map<string, number> {
  const distribution = new Map<string, number>();
  if (cents <= 0) return distribution;

  // Sort by fractional part descending
  shares.sort((a, b) => b.fractional - a.fractional);

  // Distribute 1 cent to the top 'cents' recipients
  for (let i = 0; i < cents && i < shares.length; i++) {
    const share = shares[i];
    if (share) {
      distribution.set(share.recipient, 1);
    }
  }
  return distribution;
}

/**
 * Calculates the revenue split breakdown deterministically.
 * @param input - Calculation input with amount and splits
 * @returns Detailed breakdown with platform fees and distribution
 * @throws {Error} - 'PercentageModelRequired', 'RevenueSplitInvalid:SumNot100'
 */
export function calculateRevenueSplit({ amount, splits }: ICalculationInput): ICalculationOutput {
  // 1. Calculate Platform Fee (deducted from gross)
  const platformFee = Math.round(amount * (PLATFORM_FEE_PERCENT / 100)); // Round to nearest cent
  const netAmountAfterFee = amount - platformFee;
  const taxWithheld = 0; // For Phase 1, no tax withholding

  // 2. Prepare Split Calculation
  const percentageSplits = splits.filter(s => s.percentage !== undefined);
  if (percentageSplits.length === 0) {
    throw new Error('PercentageModelRequired');
  }

  // Validate sum=100 (Critical check)
  const totalPercentage = percentageSplits.reduce((sum, s) => sum + (s.percentage || 0), 0);
  if (Math.abs(totalPercentage - 100) > 0.01) {
    // Allow small floating point errors
    throw new Error('RevenueSplitInvalid:SumNot100'); // Mongoose hook should catch this on save
  }

    // 3. Determine Gross Shares (Before applying fee/tax on a per-recipient basis)
    const rawShares = percentageSplits.map(split => {
      const exactShare = netAmountAfterFee * (split.percentage! / 100);
      const recipientId = split.userId?.toString() || split._id?.toString() || 'unknown';
      return {
        recipientId, // Use userId or split ID as recipient key
        placeholder: split.placeholder,
        percentage: split.percentage!,
        exactShare: exactShare,
        floorShare: Math.floor(exactShare), // Integer part
        fractional: exactShare - Math.floor(exactShare), // Fractional part
      };
    });

  // 4. Distribute Residual Cents (Ensures sum(netAmount) == netAmountAfterFee)
  const floorSum = rawShares.reduce((sum, s) => sum + s.floorShare, 0);
  const residualCents = netAmountAfterFee - floorSum;

  const residualDistribution = distributeResidualCents(
    residualCents,
    rawShares.map(s => ({
      recipient: s.recipientId,
      fractional: s.fractional,
    }))
  );

  // 5. Final Breakdown Construction
  const breakdown: IRecipientShare[] = rawShares.map(share => {
    const centsAdjustment = residualDistribution.get(share.recipientId) || 0;
    const finalNet = share.floorShare + centsAdjustment;

    return {
      recipientId: share.recipientId,
      placeholder: share.placeholder,
      grossShare: finalNet, // For simplicity, net is set as grossShare in this model
      platformFeeShare: Math.round(platformFee * (share.percentage / 100)), // Split fee proportionally
      netAmount: finalNet,
    };
  });

  // Final check for conservation of currency (sum of final net should equal net after fees)
  const finalNetSum = breakdown.reduce((sum, s) => sum + s.netAmount, 0);
  if (finalNetSum !== netAmountAfterFee) {
    // This indicates a bug in the rounding logic or an unexpected float error
    console.error('CRITICAL ERROR: Currency conservation failed.', { finalNetSum, netAmountAfterFee });
  }

  return {
    grossAmount: amount,
    platformFee,
    taxWithheld,
    totalDistributed: finalNetSum,
    breakdown,
  };
}

