// eslint-disable-next-line @typescript-eslint/no-var-requires
require('leaked-handles').set({
  fullStack: true, // use full stack traces
  timeout: 30000, // run every 30 seconds instead of 5.
  debugSockets: true // pretty print tcp thrown exceptions.
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import {configureEnvVariables, ETHERLIME_ACCOUNTS} from '@statechannels/devtools';
import axios from 'axios';
import {
  DBAdmin,
  overwriteConfigWithDatabaseConnection,
  Wallet as ChannelWallet,
  defaultTestConfig
} from '@statechannels/server-wallet';
import {Contract, providers} from 'ethers';
import {Logger} from '@graphprotocol/common-ts';

import {clearExistingChannels, generateAllocationIdAndKeys} from '../src/utils';
import {
  PAYER_SERVER_URL,
  RECEIPT_SERVER_DB_NAME,
  PAYER_SERVER_DB_NAME,
  REQUEST_CID,
  RESPONSE_CID,
  TEST_SUBGRAPH_ID
} from '../src/constants';
import {createPaymentServer, createReceiptServer} from '../src/external-server';

import {
  getChannels,
  getChannelsForAllocations,
  makeEthAssetHolderContract,
  mineNBlocks,
  setupLogging,
  successfulPayment,
  syncChannels
} from './e2e-utils';

configureEnvVariables();

// Setup / Configuration
jest.setTimeout(60_000);

setTimeout(() => process.exit(1), 180_000);

const NUM_ALLOCATIONS = 2;

const useLedger = process.env.USE_LEDGER || false;
const useChain = process.env.FUNDING_STRATEGY === 'Direct';
const LOG_FILE = `/tmp/e2e-test-${useLedger ? 'with-ledger' : 'without-ledger'}-${
  useChain ? 'with-chain' : 'without-chain'
}.log`;

const serverArgs = [
  `--useLedger ${useLedger}`,
  `--logFile ${LOG_FILE}`,
  `--fundingStrategy ${process.env.FUNDING_STRATEGY || 'Fake'}`,
  `--amountOfWorkerThreads ${process.env.AMOUNT_OF_WORKER_THREADS || 0}`,
  `--numAllocations ${NUM_ALLOCATIONS}`
];

const gatewayServer = createPaymentServer(serverArgs);
const indexerServer = createReceiptServer(serverArgs);

const baseConfig = defaultTestConfig({
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
});

const payerConfig = overwriteConfigWithDatabaseConnection(baseConfig, {
  database: PAYER_SERVER_DB_NAME
});

const receiverConfig = overwriteConfigWithDatabaseConnection(baseConfig, {
  database: RECEIPT_SERVER_DB_NAME
});

// Setup / Teardown callbacks
let logger: Logger;
let provider: providers.JsonRpcProvider;
let assetHolder: Contract;
let paymentWallet: ChannelWallet;
let receiptWallet: ChannelWallet;
let mineBlocksFunction: () => void;

beforeAll(async () => {
  logger = setupLogging(LOG_FILE);

  if (process.env.RPC_ENDPOINT /* chain-setup.ts */) {
    provider = new providers.JsonRpcProvider(process.env.RPC_ENDPOINT);
    assetHolder = makeEthAssetHolderContract(
      provider,
      process.env.ETH_ASSET_HOLDER_ADDRESS as string
    );
    mineBlocksFunction = mineNBlocks(provider, 6);
    assetHolder.on('Deposited', mineBlocksFunction);
    assetHolder.on('AllocationUpdated', mineBlocksFunction);
  }

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
  console.log('stopping servers');
  await Promise.all([gatewayServer.stop(), indexerServer.stop()]);
  console.log('servers stopped');
});

afterAll(async () => {
  if (process.env.RPC_ENDPOINT /* chain-setup.ts */) {
    assetHolder.off('Deposited', mineBlocksFunction);
    assetHolder.off('AllocationUpdated', mineBlocksFunction);
  }

  await paymentWallet.destroy();
  await receiptWallet.destroy();
});

// Tests

describe('Payment & Receipt Managers E2E', () => {
  test(`Can create and pay with ${NUM_ALLOCATIONS} allocations`, async () => {
    // Make 2 payments per allocation
    const allocations = generateAllocationIdAndKeys(NUM_ALLOCATIONS);
    const promises = allocations.map(() => successfulPayment(PAYER_SERVER_URL));

    for (const {status, data} of await Promise.all(promises)) {
      expect(status).toBe(200);
      expect(data).toMatchObject({
        type: 'query-accepted',
        requestCID: REQUEST_CID,
        responseCID: RESPONSE_CID,
        subgraphDeploymentID: TEST_SUBGRAPH_ID.toString()
      });
    }
    const receiptChannels = await getChannels(receiptWallet);
    const paymentChannels = await getChannels(paymentWallet);

    for (const allocationId of allocations.map((a) => a.allocationId)) {
      const receiptChannelsForAllocation = getChannelsForAllocations(receiptChannels, allocationId);

      const paymentChannelsForAllocation = getChannelsForAllocations(paymentChannels, allocationId);

      expect(receiptChannelsForAllocation).toHaveLength(NUM_ALLOCATIONS);
      expect(paymentChannelsForAllocation).toHaveLength(NUM_ALLOCATIONS);

      for (const {status} of receiptChannelsForAllocation) expect(status).toBe('running');
      for (const {status} of paymentChannelsForAllocation) expect(status).toBe('running');
    }
  });

  test(`Can remove ${NUM_ALLOCATIONS} allocations using syncAllocations`, async () => {
    await axios.post(`${PAYER_SERVER_URL}/syncAllocations`);

    const receiptChannels = await getChannels(receiptWallet);
    const paymentChannels = await getChannels(paymentWallet);

    for (const {status} of receiptChannels) expect(status).toBe('closed');
    for (const {status} of paymentChannels) expect(status).toBe('closed');
  });

  test('Payment and Receipt can get back in sync if indexer offline', async () => {
    // The default number of channels per allocation is 2
    const paymentNotReceived = () =>
      successfulPayment(PAYER_SERVER_URL, {expectPaymentNotReceived: true});

    // Make one successful payment
    await expect(successfulPayment(PAYER_SERVER_URL)).resolves.toMatchObject({status: 200});

    // Make a payment, but never receive a reply
    await expect(paymentNotReceived()).rejects.toThrowError('Request failed with status code 500');

    // Make another successful payment (useable channels is now 1, down from 2)
    await expect(successfulPayment(PAYER_SERVER_URL)).resolves.toMatchObject({status: 200});

    // Make a payment, but never receive a reply
    await expect(paymentNotReceived()).rejects.toThrowError('Request failed with status code 500');

    // With no more channels available, payments start failing
    await expect(successfulPayment(PAYER_SERVER_URL)).rejects.toThrowError(
      'Request failed with status code 406'
    );

    // Call syncChannels (return to 2 good channels)
    await expect(syncChannels(PAYER_SERVER_URL)).resolves.toMatchObject({status: 200});

    // Make a successful payment (to verify sync channels worked)
    await expect(successfulPayment(PAYER_SERVER_URL)).resolves.toMatchObject({status: 200});
  });

  test('Payment and Receipt can get back in sync if payer missed receipt', async () => {
    const receiptNotReceived = () =>
      successfulPayment(PAYER_SERVER_URL, {expectReceiptNotReceived: true});

    // Make one successful payment
    await expect(successfulPayment(PAYER_SERVER_URL)).resolves.toMatchObject({status: 200});

    // Make a payment, but discard the result (stalling 1 of 2 channels)
    await expect(receiptNotReceived()).rejects.toThrowError('Request failed with status code 500');

    // Make a payment, but discard the result (stalling 2nd of 2 channels)
    await expect(receiptNotReceived()).rejects.toThrowError('Request failed with status code 500');

    // With no more channels available, payments start failing
    await expect(successfulPayment(PAYER_SERVER_URL)).rejects.toThrowError(
      'Request failed with status code 406'
    );

    // Call syncChannels (return to 2 good channels)
    await expect(syncChannels(PAYER_SERVER_URL)).resolves.toMatchObject({status: 200});

    // Make a successful payment (to verify sync channels worked)
    await expect(successfulPayment(PAYER_SERVER_URL)).resolves.toMatchObject({status: 200});
  });
});
