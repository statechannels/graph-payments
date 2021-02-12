/* eslint-disable @typescript-eslint/no-explicit-any */

import {configureEnvVariables} from '@statechannels/devtools';
import _ from 'lodash';
import {
  DBAdmin,
  overwriteConfigWithDatabaseConnection,
  Wallet as ChannelWallet,
  defaultTestConfig
} from '@statechannels/server-wallet';
import {Logger} from '@graphprotocol/common-ts';

import {clearExistingChannels, generateAllocations} from '../src/utils';
import {RECEIPT_SERVER_DB_NAME, PAYER_SERVER_DB_NAME, PAYER_SERVER_URL} from '../src/constants';
import {createPaymentServer, createReceiptServer} from '../src/external-server';

import {
  getChannels,
  getChannelsForAllocations,
  setupLogging,
  successfulPayment,
  syncChannels,
  syncAllocations
} from './e2e-utils';

// Setup / Configuration
jest.setTimeout(100_000);

configureEnvVariables();

const LOG_FILE = `/tmp/bad-network-test-without-chain.log`;

const NUM_ALLOCATIONS = 5;

const serverArgs = [
  `--amountOfWorkerThreads ${process.env.AMOUNT_OF_WORKER_THREADS || 0}`,
  `--channelsPerAllocation 5`,
  `--dropIncomingRate 0.03`, // 3% chance incoming messages are dropped
  `--dropOutgoingRate 0`, // 0% chance outgoing messages are dropped
  `--fundingStrategy Fake`,
  `--logFile ${LOG_FILE}`,
  `--meanDelay 15`, // Mean 15ms delay between message send and receive (distribution)
  `--useLedger true`
];

const gatewayServer = createPaymentServer(serverArgs);
const indexerServer = createReceiptServer([
  ...serverArgs,
  // receipt-server uses numAllocations field to pre-compute private
  // keys for attestation signing but no action is taken on startup
  `--numAllocations ${NUM_ALLOCATIONS}`
]);

const baseConfig = defaultTestConfig({
  networkConfiguration: {
    chainNetworkID: process.env.CHAIN_ID
      ? parseInt(process.env.CHAIN_ID)
      : defaultTestConfig().networkConfiguration.chainNetworkID
  },
  chainServiceConfiguration: {
    attachChainService: false
  }
});

const payerConfig = overwriteConfigWithDatabaseConnection(baseConfig, {
  database: PAYER_SERVER_DB_NAME
});

const receiverConfig = overwriteConfigWithDatabaseConnection(baseConfig, {
  database: RECEIPT_SERVER_DB_NAME
});

// Setup / Teardown callbacks
let logger: Logger;
let paymentWallet: ChannelWallet;
let receiptWallet: ChannelWallet;

beforeAll(async () => {
  logger = setupLogging(LOG_FILE);
  await DBAdmin.migrateDatabase(payerConfig);
  await DBAdmin.migrateDatabase(receiverConfig);
  paymentWallet = await ChannelWallet.create(payerConfig);
  receiptWallet = await ChannelWallet.create(receiverConfig);
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
  await paymentWallet.destroy();
  await receiptWallet.destroy();
});

describe('Payment & Receipt Managers E2E', () => {
  test(`Can create channels and make 20 payments`, async () => {
    const allocations = generateAllocations(NUM_ALLOCATIONS);

    await syncAllocations(PAYER_SERVER_URL, {
      requests: allocations.map((allocation) => ({
        allocation: {
          ...allocation,
          id: allocation.id,
          subgraphDeploymentID: {
            ...allocation.subgraphDeploymentID,
            display: allocation.subgraphDeploymentID.display, // getter
            ipfsHash: allocation.subgraphDeploymentID.ipfsHash, // getter
            bytes32: allocation.subgraphDeploymentID.bytes32 // getter
          }
        },
        num: NUM_ALLOCATIONS,
        type: 'SetTo'
      }))
    });

    const receiptChannels = await getChannels(receiptWallet);
    const paymentChannels = await getChannels(paymentWallet);

    for (const allocationId of _.map(allocations, 'id')) {
      const receiptChannelsForAllocation = getChannelsForAllocations(receiptChannels, allocationId);

      const paymentChannelsForAllocation = getChannelsForAllocations(paymentChannels, allocationId);

      expect(receiptChannelsForAllocation).toHaveLength(NUM_ALLOCATIONS);
      expect(paymentChannelsForAllocation).toHaveLength(NUM_ALLOCATIONS);

      for (const {status} of receiptChannelsForAllocation) expect(status).toBe('running');
      for (const {status} of paymentChannelsForAllocation) expect(status).toBe('running');
    }

    // Can then make payments
    let numPayments = 0;

    while (numPayments < 20) {
      await syncChannels(PAYER_SERVER_URL);
      const {status} = await successfulPayment(PAYER_SERVER_URL);
      if (status === 200) numPayments++;
    }

    expect(numPayments).toBeGreaterThanOrEqual(20);
  });
});
