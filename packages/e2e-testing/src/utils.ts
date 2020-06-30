import {toAddress} from '@graphprotocol/common-ts';
import {Allocation} from '@graphprotocol/payments/dist/query-engine-types';
import {signAttestation} from '@graphprotocol/statechannels-contracts';
import {BigNumber, Wallet} from 'ethers';
import _ from 'lodash';
/* eslint-disable @typescript-eslint/no-explicit-any */
import {Client} from 'pg';
import pino from 'pino';
import {
  CHAIN_ID,
  RECEIPT_PRIVATE_KEY,
  REQUEST_CID,
  RESPONSE_CID,
  TEST_SUBGRAPH_ID,
  VERIFYING_CONTRACT
} from './constants';

export async function clearExistingChannels(databaseName: string): Promise<void> {
  const client = new Client({
    port: parseInt(process.env.SERVER_DB_PORT || ''),
    user: process.env.SERVER_DB_USER || '',
    host: process.env.SERVER_DB_HOST || '',
    database: databaseName
  });
  try {
    await client.connect();
    // It's possible that there are no tables yet if the migration hasn't been run
    // so we check to make sure the channels table exists
    const result = await client.query(
      ` SELECT table_name FROM information_schema.tables WHERE table_name = 'channels'`
    );

    if (result.rowCount > 0) {
      await client.query('TRUNCATE TABLE channels CASCADE');
    }

    const [paymentManagerSchemaPresent] = (
      await client.query(
        `SELECT * FROM information_schema.tables WHERE table_name = 'payment_channels'`
      )
    ).rows;

    if (paymentManagerSchemaPresent) {
      await client.query('TRUNCATE TABLE payment_manager.payment_channels').catch(console.warn);
      await client.query('TRUNCATE TABLE payment_manager.ledger_channels').catch(console.warn);
    }
  } finally {
    await client.end();
  }
}

const hooks = {
  logMethod(inputArgs: any[], method: any) {
    if (inputArgs.length >= 2) {
      const arg1 = inputArgs.shift();
      const arg2 = inputArgs.shift();
      return method.apply(this, [arg2, arg1, ...inputArgs]);
    }
    return method.apply(this, inputArgs);
  }
};

export const createTestLogger = (file?: string): pino.Logger => {
  return file ? pino({hooks}, pino.destination(file)) : (pino({hooks}) as any);
};

export const getTestAttestation = async (
  privateKey = RECEIPT_PRIVATE_KEY
): Promise<{responseCID: string; signature: string}> => {
  const signature = await signAttestation(
    privateKey,
    REQUEST_CID,
    RESPONSE_CID,
    TEST_SUBGRAPH_ID.toString(),
    CHAIN_ID,
    VERIFYING_CONTRACT
  );

  return {
    responseCID: RESPONSE_CID,
    signature
  };
};

export function generateAllocationIdAndKeys(
  n: number
): {privateKey: string; allocationId: string}[] {
  const MNEMONIC = 'radar blur cabbage chef fix engine embark joy scheme fiction master release';
  return _.range(n).map((i) => {
    const path = `m/44'/60'/1'/0/${i}`;
    const {address, privateKey} = Wallet.fromMnemonic(MNEMONIC, path);
    return {
      privateKey,
      allocationId: address
    };
  });
}

export function generateAllocations(n: number): Allocation[] {
  const TEST_ALLOCATION: Allocation = {
    id: toAddress('0x2222E21c8019b14dA16235319D34b5Dd83E644A9'),
    indexer: {
      id: toAddress('0x333356F625259653A2B6d7Da44162631DCbdF93F'),
      createdAt: Date.parse('2020-05-25'),
      stakedTokens: BigNumber.from(0),
      url: 'http://network-subgraph-indexer-1/'
    },
    subgraphDeploymentID: TEST_SUBGRAPH_ID,
    allocatedTokens: BigNumber.from(0),
    createdAtEpoch: 0
  };
  return generateAllocationIdAndKeys(n).map((pair) => ({
    ...TEST_ALLOCATION,
    id: toAddress(pair.allocationId)
  }));
}

export async function generateAttestations(
  n: number
): Promise<Record<string, {responseCID: string; signature: string}>> {
  const record: Record<string, {responseCID: string; signature: string}> = {};
  for (const pair of generateAllocationIdAndKeys(n)) {
    const attestation = await getTestAttestation(pair.privateKey);
    record[pair.privateKey] = attestation;
  }
  return record;
}
