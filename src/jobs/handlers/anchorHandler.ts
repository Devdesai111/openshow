// src/jobs/handlers/anchorHandler.ts
import { IJob } from '../../models/job.model';
import { AgreementService } from '../../services/agreement.service'; 
import * as crypto from 'crypto';

const agreementService = new AgreementService();

// Mock External Chain Gateway
class ChainGateway {
    // Simulates sending the hash to an external API/Smart Contract
    public async submitHash(hash: string, chain: string): Promise<{ txId: string }> {
        if (chain === 'fail_test') {
            throw new Error('ChainNetworkBusy');
        }
        
        // Mock success with a unique transaction ID
        const txId = `0x${crypto.randomBytes(32).toString('hex')}`;
        console.log(`Anchoring Hash ${hash.substring(0, 10)}... on ${chain}. TXID: ${txId}`);
        return { txId };
    }
}
const chainGateway = new ChainGateway();

/**
 * Worker Logic Handler for the 'blockchain.anchor' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handleAnchorJob(job: IJob): Promise<{ txId: string, chain: string }> {
    const { agreementId, immutableHash, chain } = job.payload;
    
    if (!agreementId || !immutableHash || !chain) {
        throw new Error('JobDataMissing: Missing agreementId, immutableHash, or chain.');
    }
    
    // 1. Submit Hash to External Chain Gateway
    const { txId } = await chainGateway.submitHash(immutableHash, chain);

    // 2. Report Back to Agreement Service (Update the Parent Agreement Record)
    await agreementService.updateAnchorTxId(agreementId, txId, chain);

    // 3. Return the result payload
    return { txId, chain };
}

