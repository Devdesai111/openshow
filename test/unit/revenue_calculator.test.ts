import { calculateRevenueSplit } from '../../src/utils/revenueCalculator';
import { IRevenueSplit } from '../../src/models/project.model';
import { Types } from 'mongoose';

describe('Revenue Calculator Unit Tests', () => {
  describe('calculateRevenueSplit', () => {
    it('T31.1 - should produce deterministic 50/50 split on 100 cents', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), percentage: 50 },
        { _id: new Types.ObjectId(), percentage: 50 },
      ];

      // Act
      const result = calculateRevenueSplit({ amount: 100, splits });

      // Assert
      expect(result.grossAmount).toBe(100);
      expect(result.platformFee).toBe(5); // 5% of 100 = 5
      expect(result.totalDistributed).toBe(95); // 100 - 5 = 95
      expect(result.breakdown).toHaveLength(2);
      // Largest Remainder Method: 95/2 = 47.5 each
      // Floor: 47, 47 = 94, residual = 1 cent
      // One recipient gets the extra cent (sorted by fractional part)
      const netAmounts = result.breakdown.map(b => b?.netAmount || 0);
      expect(netAmounts.reduce((a, b) => a + b, 0)).toBe(95); // Conservation check
      expect(netAmounts).toEqual(expect.arrayContaining([47, 48])); // One gets 47, one gets 48
    });

    it('T31.2 - should use Largest Remainder Method for 33.33/33.33/33.33 split on 100 cents', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), percentage: 33.33 },
        { _id: new Types.ObjectId(), percentage: 33.33 },
        { _id: new Types.ObjectId(), percentage: 33.34 }, // Sums to 100
      ];

      // Act
      const result = calculateRevenueSplit({ amount: 100, splits });

      // Assert
      expect(result.grossAmount).toBe(100);
      expect(result.platformFee).toBe(5); // 5% of 100 = 5
      expect(result.totalDistributed).toBe(95); // 100 - 5 = 95

      const netAmounts = result.breakdown.map(b => b.netAmount);
      const total = netAmounts.reduce((sum, amt) => sum + amt, 0);
      expect(total).toBe(95); // Conservation check

      // Check that Largest Remainder Method distributes residual cents
      // 95 cents / 3 = 31.666... cents each
      // Floor: 31, 31, 31 = 93, residual = 2 cents
      // Should distribute 1 cent to top 2 recipients (largest fractional parts)
      expect(netAmounts).toEqual(expect.arrayContaining([32, 32, 31])); // Two recipients get 32, one gets 31
    });

    it('should correctly calculate platform fee (5%)', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), percentage: 100 },
      ];

      // Act
      const result = calculateRevenueSplit({ amount: 10000, splits });

      // Assert
      expect(result.platformFee).toBe(500); // 5% of 10000 = 500
      expect(result.totalDistributed).toBe(9500); // 10000 - 500 = 9500
      expect(result.breakdown[0]?.netAmount).toBe(9500);
    });

    it('should handle single recipient with 100% split', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), percentage: 100 },
      ];

      // Act
      const result = calculateRevenueSplit({ amount: 1000, splits });

      // Assert
      expect(result.platformFee).toBe(50); // 5% of 1000 = 50
      expect(result.totalDistributed).toBe(950); // 1000 - 50 = 950
      expect(result.breakdown).toHaveLength(1);
      expect(result.breakdown[0]?.netAmount).toBe(950);
      expect(result.breakdown[0]?.grossShare).toBe(950);
    });

    it('should handle odd number with 50/50 split (101 cents)', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), percentage: 50 },
        { _id: new Types.ObjectId(), percentage: 50 },
      ];

      // Act
      const result = calculateRevenueSplit({ amount: 101, splits });

      // Assert
      expect(result.grossAmount).toBe(101);
      expect(result.platformFee).toBe(5); // 5% of 101 = 5.05, rounded = 5
      expect(result.totalDistributed).toBe(96); // 101 - 5 = 96
      expect((result.breakdown[0]?.netAmount || 0) + (result.breakdown[1]?.netAmount || 0)).toBe(96);
    });

    it('should throw error if splits sum to != 100%', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), percentage: 90 },
      ];

      // Act & Assert
      expect(() => {
        calculateRevenueSplit({ amount: 100, splits });
      }).toThrow('RevenueSplitInvalid:SumNot100');
    });

    it('should throw error if no percentage splits provided', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), fixedAmount: 50 },
      ];

      // Act & Assert
      expect(() => {
        calculateRevenueSplit({ amount: 100, splits });
      }).toThrow('PercentageModelRequired');
    });

    it('should handle multiple recipients with different percentages', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), percentage: 60 },
        { _id: new Types.ObjectId(), percentage: 30 },
        { _id: new Types.ObjectId(), percentage: 10 },
      ];

      // Act
      const result = calculateRevenueSplit({ amount: 10000, splits });

      // Assert
      expect(result.grossAmount).toBe(10000);
      expect(result.platformFee).toBe(500); // 5%
      expect(result.totalDistributed).toBe(9500); // 10000 - 500

      // Check distribution
      expect(result.breakdown[0]?.netAmount).toBe(5700); // 60% of 9500 = 5700
      expect(result.breakdown[1]?.netAmount).toBe(2850); // 30% of 9500 = 2850
      expect(result.breakdown[2]?.netAmount).toBe(950); // 10% of 9500 = 950
      expect((result.breakdown[0]?.netAmount || 0) + (result.breakdown[1]?.netAmount || 0) + (result.breakdown[2]?.netAmount || 0)).toBe(9500);
    });

    it('should handle placeholder splits', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), placeholder: 'Team Pool', percentage: 50 },
        { _id: new Types.ObjectId(), userId: new Types.ObjectId(), percentage: 50 },
      ];

      // Act
      const result = calculateRevenueSplit({ amount: 100, splits });

      // Assert
      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0]?.placeholder).toBe('Team Pool');
      expect(result.breakdown[1]?.recipientId).toBeDefined();
    });

    it('should ensure currency conservation (Gross - Fees = Sum(Net Amounts))', () => {
      // Arrange - Multiple edge cases
      const testCases = [
        { amount: 100, splits: [{ _id: new Types.ObjectId(), percentage: 100 }] },
        { amount: 101, splits: [{ _id: new Types.ObjectId(), percentage: 50 }, { _id: new Types.ObjectId(), percentage: 50 }] },
        { amount: 333, splits: [{ _id: new Types.ObjectId(), percentage: 33 }, { _id: new Types.ObjectId(), percentage: 33 }, { _id: new Types.ObjectId(), percentage: 34 }] },
        { amount: 10000, splits: [{ _id: new Types.ObjectId(), percentage: 25 }, { _id: new Types.ObjectId(), percentage: 25 }, { _id: new Types.ObjectId(), percentage: 25 }, { _id: new Types.ObjectId(), percentage: 25 }] },
      ];

      testCases.forEach(testCase => {
        // Act
        const result = calculateRevenueSplit(testCase);

        // Assert
        const netSum = result.breakdown.reduce((sum, b) => sum + b.netAmount, 0);
        const expectedNet = result.grossAmount - result.platformFee;
        expect(netSum).toBe(expectedNet); // Conservation check
      });
    });

    it('should calculate platformFeeShare proportionally for each recipient', () => {
      // Arrange
      const splits: IRevenueSplit[] = [
        { _id: new Types.ObjectId(), percentage: 60 },
        { _id: new Types.ObjectId(), percentage: 40 },
      ];

      // Act
      const result = calculateRevenueSplit({ amount: 10000, splits });

      // Assert
      const totalPlatformFee = result.breakdown.reduce((sum, b) => sum + (b?.platformFeeShare || 0), 0);
      expect(totalPlatformFee).toBe(500); // 5% of 10000 = 500
      expect(result.breakdown[0]?.platformFeeShare).toBe(300); // 60% of 500 = 300
      expect(result.breakdown[1]?.platformFeeShare).toBe(200); // 40% of 500 = 200
    });
  });
});

