/* eslint-disable @typescript-eslint/no-explicit-any */
import {createPaymentServer, createReceiptServer} from '../src/external-server';
import {
  PAYER_SERVER_URL,
  RECEIPT_SERVER_DB_NAME,
  PAYER_SERVER_DB_NAME,
  REQUEST_CID,
  RESPONSE_CID,
  TEST_SUBGRAPH_ID
} from '../src/constants';
import {clearExistingChannels, createTestLogger, generateAllocationIdAndKeys} from '../src/utils';
import * as fs from 'fs';
import {configureEnvVariables, ETHERLIME_ACCOUNTS} from '@statechannels/devtools';

import axios from 'axios';
import _ from 'lodash';
import {Wallet as ChannelWallet} from '@statechannels/server-wallet';
jest.setTimeout(60_000);

const NUM_ALLOCATIONS = 2;

configureEnvVariables();

const useLedger = process.env.USE_LEDGER || false;
const useChain = process.env.FUNDING_STRATEGY === 'Direct';

export const LOG_FILE = `/tmp/e2e-test-${useLedger ? 'with-ledger' : 'without-ledger'}-${
  useChain ? 'with-chain' : 'without-chain'
}.log`;
const logFileArg = `--logFile ${LOG_FILE}`;
const ledgerArg = `--useLedger ${useLedger}`;
const fundingArg = `--fundingStrategy ${process.env.FUNDING_STRATEGY || 'Fake'}`;
const threadingArg = `--amountOfWorkerThreads ${process.env.AMOUNT_OF_WORKER_THREADS || 0}`;

const numAllocationsArg = `--numAllocations ${NUM_ALLOCATIONS}`;

const serverArgs = [ledgerArg, logFileArg, fundingArg, threadingArg, numAllocationsArg];

const gatewayServer = createPaymentServer(serverArgs);
const indexerServer = createReceiptServer(serverArgs);
import {defaultTestConfig} from '@statechannels/server-wallet';
import {ChannelResult} from '@statechannels/client-api-schema';
import {BigNumber, providers} from 'ethers';
import {ContractArtifacts} from '@statechannels/nitro-protocol';
import {Contract} from 'ethers';
import {NULL_APP_DATA} from '@statechannels/wallet-core';
import {Logger} from '@graphprotocol/common-ts';
let logger: Logger;

const paymentWallet = ChannelWallet.create(
  defaultTestConfig({
    databaseConfiguration: {connection: {database: PAYER_SERVER_DB_NAME}},
    networkConfiguration: {
      chainNetworkID: process.env.CHAIN_ID
        ? parseInt(process.env.CHAIN_ID)
        : defaultTestConfig().networkConfiguration.chainNetworkID
    },
    chainServiceConfiguration: {
      attachChainService: useChain,
      provider: process.env.RPC_ENDPOINT,
      pk: ETHERLIME_ACCOUNTS[0].privateKey
    }
  })
);

const receiptwallet = ChannelWallet.create(
  defaultTestConfig({
    databaseConfiguration: {connection: {database: RECEIPT_SERVER_DB_NAME}},
    networkConfiguration: {
      chainNetworkID: process.env.CHAIN_ID
        ? parseInt(process.env.CHAIN_ID)
        : defaultTestConfig().networkConfiguration.chainNetworkID
    },
    chainServiceConfiguration: {
      attachChainService: useChain,
      provider: process.env.RPC_ENDPOINT,
      pk: ETHERLIME_ACCOUNTS[0].privateKey
    }
  })
);

const getChannels = async (database: 'receipt' | 'payment') => {
  const wallet = database === 'receipt' ? receiptwallet : paymentWallet;
  // Filter out the ledger channels results
  return (await wallet.getChannels()).channelResults.filter((c) => c.appData !== NULL_APP_DATA);
};

const expectChannelsHaveStatus = async (
  channels: ChannelResult[],
  status: 'running' | 'closed'
) => {
  for (const channel of channels) {
    expect(channel).toMatchObject({status});
  }
};
// We know the destination of the second allocationItem will be the allocationId
const getChannelsForAllocations = (channels: ChannelResult[], allocationId: string) =>
  channels.filter((c) =>
    BigNumber.from(allocationId).eq(c.allocations[0].allocationItems[1].destination)
  );

const successfulPayment = (params?: {
  privateKey?: string;
  allocationId?: string;
  expectPaymentNotReceived?: boolean;
  expectReceiptNotReceived?: boolean;
}) => {
  const defaultParams = generateAllocationIdAndKeys(1)[0];

  return axios.get(`${PAYER_SERVER_URL}/sendPayment`, {params: _.merge(defaultParams, params)});
};
const syncChannels = () => axios.get(`${PAYER_SERVER_URL}/syncChannels`);

describe('Payment & Receipt Managers E2E', () => {
  let provider: providers.JsonRpcProvider;
  let assetHolder: Contract;

  const mine6Blocks = () => _.range(6).forEach(() => provider?.send('evm_mine', []));

  function setupLogging() {
    LOG_FILE && fs.existsSync(LOG_FILE) && fs.truncateSync(LOG_FILE);
    logger = createTestLogger(LOG_FILE);
    (logger as any).level = 'debug';
  }

  function setupContractMonitor() {
    if (process.env.RPC_ENDPOINT /* defined in chain-setup.ts */) {
      provider = new providers.JsonRpcProvider(process.env.RPC_ENDPOINT);
      assetHolder = new Contract(
        process.env.ETH_ASSET_HOLDER_ADDRESS as string,
        ContractArtifacts.EthAssetHolderArtifact.abi,
        provider
      );
      assetHolder.on('Deposited', mine6Blocks);
      assetHolder.on('AllocationUpdated', mine6Blocks);
    }
  }

  function teardownContractMonitor() {
    if (process.env.RPC_ENDPOINT /* defined in chain-setup.ts */) {
      assetHolder.off('Deposited', mine6Blocks);
      assetHolder.off('AllocationUpdated', mine6Blocks);
    }
  }

  beforeAll(() => {
    setupLogging();
    setupContractMonitor();
  });

  beforeEach(async () => {
    try {
      await Promise.all([RECEIPT_SERVER_DB_NAME, PAYER_SERVER_DB_NAME].map(clearExistingChannels));
      await Promise.all([gatewayServer.start(logger), indexerServer.start(logger)]);
    } catch (error) {
      logger.error(error);
      process.exit(1);
    }
  });

  afterEach(async () => {
    await Promise.all([gatewayServer.stop(), indexerServer.stop()]);
  });

  afterAll(async () => {
    teardownContractMonitor();
    await paymentWallet.destroy();
    await receiptwallet.destroy();
  });
  test(`Can create and pay with ${NUM_ALLOCATIONS} allocations`, async () => {
    // Make 2 payments per allocation
    const allocations = generateAllocationIdAndKeys(NUM_ALLOCATIONS);
    const promises = allocations.map(successfulPayment);

    for (const {status, data} of await Promise.all(promises)) {
      expect(status).toBe(200);
      expect(data).toMatchObject({
        type: 'query-accepted',
        requestCID: REQUEST_CID,
        responseCID: RESPONSE_CID,
        subgraphDeploymentID: TEST_SUBGRAPH_ID.toString()
      });
    }
    const receiptChannels = await getChannels('receipt');
    const paymentChannels = await getChannels('payment');

    for (const allocationId of allocations.map((a) => a.allocationId)) {
      const receiptChannelsForAllocation = getChannelsForAllocations(receiptChannels, allocationId);

      const paymentChannelsForAllocation = getChannelsForAllocations(paymentChannels, allocationId);

      expect(receiptChannelsForAllocation).toHaveLength(NUM_ALLOCATIONS);
      expect(paymentChannelsForAllocation).toHaveLength(NUM_ALLOCATIONS);
      expectChannelsHaveStatus(receiptChannelsForAllocation, 'running');
      expectChannelsHaveStatus(paymentChannelsForAllocation, 'running');
    }
  });

  test(`Can remove ${NUM_ALLOCATIONS} allocations using syncAllocations`, async () => {
    await axios.post(`${PAYER_SERVER_URL}/syncAllocations`);

    const receiptChannels = await getChannels('receipt');
    const paymentChannels = await getChannels('payment');

    expectChannelsHaveStatus(receiptChannels, 'closed');
    expectChannelsHaveStatus(paymentChannels, 'closed');
  });

  test('Payment and Receipt can get back in sync if indexer offline', async () => {
    // The default number of channels per allocation is 2
    const paymentNotReceived = () => successfulPayment({expectPaymentNotReceived: true});

    // Make one successful payment
    await expect(successfulPayment()).resolves.toMatchObject({status: 200});

    // Make a payment, but never receive a reply
    await expect(paymentNotReceived()).rejects.toThrowError('Request failed with status code 500');

    // Make another successful payment (useable channels is now 1, down from 2)
    await expect(successfulPayment()).resolves.toMatchObject({status: 200});

    // Make a payment, but never receive a reply
    await expect(paymentNotReceived()).rejects.toThrowError('Request failed with status code 500');

    // With no more channels available, payments start failing
    await expect(successfulPayment()).rejects.toThrowError('Request failed with status code 406');

    // Call syncChannels (return to 2 good channels)
    await expect(syncChannels()).resolves.toMatchObject({status: 200});

    // Make a successful payment (to verify sync channels worked)
    await expect(successfulPayment()).resolves.toMatchObject({status: 200});
  });

  test('Payment and Receipt can get back in sync if payer missed receipt', async () => {
    const receiptNotReceived = () => successfulPayment({expectReceiptNotReceived: true});

    // Make one successful payment
    await expect(successfulPayment()).resolves.toMatchObject({status: 200});

    // Make a payment, but discard the result (stalling 1 of 2 channels)
    await expect(receiptNotReceived()).rejects.toThrowError('Request failed with status code 500');

    // Make a payment, but discard the result (stalling 2nd of 2 channels)
    await expect(receiptNotReceived()).rejects.toThrowError('Request failed with status code 500');

    // With no more channels available, payments start failing
    await expect(successfulPayment()).rejects.toThrowError('Request failed with status code 406');

    // Call syncChannels (return to 2 good channels)
    await expect(syncChannels()).resolves.toMatchObject({status: 200});

    // Make a successful payment (to verify sync channels worked)
    await expect(successfulPayment()).resolves.toMatchObject({status: 200});
  });
});
