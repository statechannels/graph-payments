/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs';

import {NetworkContracts} from '@graphprotocol/common-ts';
import {
  Wallet as ChannelWallet,
  defaultTestConfig,
  overwriteConfigWithDatabaseConnection
} from '@statechannels/server-wallet';
import {constants} from 'ethers';
import {BN} from '@statechannels/wallet-core';

import {createPostgresCache} from '../channel-cache';
import {ChannelManager, ChannelManagerOptions} from '../channel-manager';
import {ChannelManagerInsightEvent} from '../insights';
import {Allocation} from '../query-engine-types';

import {FakeIndexer} from './fake-indexer';
import {TEST_ALLOCATION, TEST_PAYMENT} from './crash-test-dummies';
import {
  createTestLogger,
  PAYMENT_MANAGER_TEST_DB_CONNECTION_STRING,
  PAYMENT_MANAGER_TEST_DB_NAME
} from './setup';
import {TestChannelManager} from './test-channel-manager';
import {TestPaymentManager} from './test-payment-manager';

jest.setTimeout(30_000);
const RECEIPT_PRIVATE_KEY = '0xa69a8d9fde414bdf8b5d76bbff63bd78704fe3da1d938cd10126a9e2e3e0e11f';
const DESTINATION_ADDRESS = '0xabc3F8C6836F01Fd39Cc1D1ca110F25D907Ce1CE';
const LOG_FILE = '/tmp/payment-manager-test.log';
// const LOG_FILE = undefined // turn off logging

const logger = createTestLogger(LOG_FILE).child({name: 'payment-manager'});
logger.level = 'debug';

const mockCollect = jest.fn(() => ({hash: constants.HashZero}));

const mockContracts = {
  assetHolder: {address: constants.AddressZero},
  attestationApp: {address: '0x0000000000000000000000000000000000111121' /* nonzero */},
  staking: {
    collect: mockCollect as any
  },
  disputeManager: {address: constants.AddressZero}
} as NetworkContracts;
const walletConfig = overwriteConfigWithDatabaseConnection(
  defaultTestConfig(),
  PAYMENT_MANAGER_TEST_DB_CONNECTION_STRING
);

let paymentWallet: ChannelWallet;

const cache = createPostgresCache(PAYMENT_MANAGER_TEST_DB_CONNECTION_STRING);
const cmDefaultOpts: Pick<
  ChannelManagerOptions,
  | 'logger'
  | 'contracts'
  | 'destinationAddress'
  | 'paymentChannelFundingAmount'
  | 'fundsPerAllocation'
  | 'walletConfig'
  | 'cache'
  | 'backoffStrategy'
> = {
  logger,
  contracts: mockContracts,
  destinationAddress: DESTINATION_ADDRESS,
  paymentChannelFundingAmount: BN.from(1_000_000_000),
  fundsPerAllocation: BN.from(1_000_000_000_000),
  walletConfig,
  cache,
  backoffStrategy: {
    initialDelay: 50,
    numAttempts: 1
  }
};

type MessageSender = ChannelManagerOptions['messageSender'];

async function dummyChannelManager(): Promise<ChannelManager> {
  const fakeIndexer = new FakeIndexer({logger, privateKey: RECEIPT_PRIVATE_KEY});

  const messageSender: MessageSender = (_addr, payload) => fakeIndexer.pushPayload(payload);

  return ChannelManager.create({...cmDefaultOpts, messageSender});
}
let dummyCM: ChannelManager;

beforeAll(async (done) => {
  logger.info('starting test');
  dummyCM = await dummyChannelManager();

  LOG_FILE && fs.existsSync(LOG_FILE) && fs.truncateSync(LOG_FILE);
  paymentWallet = await ChannelWallet.create(
    defaultTestConfig({
      databaseConfiguration: {connection: {database: PAYMENT_MANAGER_TEST_DB_NAME}},
      networkConfiguration: {
        chainNetworkID: process.env.CHAIN_NETWORK_ID
          ? parseInt(process.env.CHAIN_NETWORK_ID)
          : defaultTestConfig().networkConfiguration.chainNetworkID
      },
      chainServiceConfiguration: {
        attachChainService: false,
        provider: process.env.RPC_ENDPOINT,
        pk: '0x0000000000000000000000000000000000000000000000000000000000000000'
      }
    })
  );
  done();
});

beforeEach(async (done) => {
  logger.info(`Truncating ${PAYMENT_MANAGER_TEST_DB_NAME}`);
  await dummyCM.truncateDB();
  done();
});

afterAll(async (done) => {
  logger.info('shutting down');
  await dummyCM._shutdown();
  done();
});

const request = (allocation: Allocation, capacity = 2) => ({
  allocation,
  type: 'SetTo' as const,
  num: capacity
});

describe('ChannelManager', () => {
  test('removing allocations', async () => {
    // setup fake indexer
    const fakeIndexer = new FakeIndexer({logger, privateKey: RECEIPT_PRIVATE_KEY});
    const allocationId = TEST_ALLOCATION.id;

    // setup channel manager
    const messageSender: MessageSender = (_addr, payload) => fakeIndexer.pushPayload(payload);
    const channelManager = await TestChannelManager.create({...cmDefaultOpts, messageSender});

    // sync allocations
    await channelManager.syncAllocations([request(fakeIndexer.allocation(allocationId))]);

    expect(await channelManager.activeChannelCount(allocationId)).toEqual(2);

    // close allocations
    await channelManager.removeAllocations([allocationId]);
    expect(await channelManager.activeChannelCount(allocationId)).toEqual(0);
  });

  test('opening/paying/closing', async () => {
    let insight: Promise<ChannelManagerInsightEvent>;

    logger.info('setup fake indexer');
    const fakeIndexer = new FakeIndexer({logger, privateKey: RECEIPT_PRIVATE_KEY});
    const allocationId = TEST_ALLOCATION.id;

    // setup channel manager
    const messageSender: MessageSender = (_addr, payload) => fakeIndexer.pushPayload(payload);
    const fundingStrategy = 'Fake'; // <-- Fake ledger channel
    const channelManager = await TestChannelManager.create({
      ...cmDefaultOpts,
      messageSender,
      cache,
      fundingStrategy
    });

    channelManager.channelInsights.attach((data) => logger.info('Channel insight', {data}));

    const paymentManager = await TestPaymentManager.create({
      walletConfig,
      logger,
      cache
    });

    logger.info('sync allocations');
    insight = new Promise((resolve) =>
      channelManager.channelInsights.attachOnce((e) => e.type === 'ChannelsReady', resolve)
    );

    await channelManager.syncAllocations([request(fakeIndexer.allocation(allocationId))]);
    await expect(insight).resolves.toMatchObject({type: 'ChannelsReady'});
    expect(await channelManager.activeChannelCount(allocationId)).toEqual(2);

    logger.info('block the indexer');
    fakeIndexer.block();

    logger.info('make two payments');
    const makePayment = async () => {
      logger.debug(`creating payment for ${allocationId}`);
      const payment = await paymentManager.createPayment(TEST_PAYMENT);
      logger.debug(`payment created for ${allocationId}`);
      const result = await fakeIndexer.pushPayload(payment as any);
      logger.debug('response received from indexer');
      await paymentManager.submitReceipt(result);
    };
    const payment1 = makePayment();
    const payment2 = makePayment();

    logger.info('third payment fails as both channels are blocked');
    await expect(makePayment()).rejects.toThrowError(/No free channels found/);

    logger.info('unblock the indexer');
    await fakeIndexer.unblock();

    logger.info('wait for payments to be successful');
    await Promise.all([payment1, payment2]);

    logger.info('check we can make payments again');
    await makePayment();

    logger.info('check we can increase capacity');
    await channelManager.syncAllocations([request(fakeIndexer.allocation(allocationId), 4)]);
    await Promise.all(Array(4).map(makePayment));

    logger.info('close the channels');

    // Uncomment after ledger funding is required
    // await expect(channelManager.ledgerChannelExists(allocationId)).resolves.toBeTruthy();

    insight = new Promise((resolve) => channelManager.channelInsights.attachOnce(resolve));
    await channelManager.syncAllocations([]);

    // Uncomment after ledger funding is required
    // await expect(channelManager.ledgerChannelExists(allocationId)).resolves.not.toBeTruthy();
    await expect(channelManager.activeChannelCount(allocationId)).resolves.toEqual(0);
  });

  test('reallocating', async () => {
    // setup fake indexer
    const fakeIndexer = new FakeIndexer({logger, privateKey: RECEIPT_PRIVATE_KEY});
    const allocationId = TEST_ALLOCATION.id;

    // setup channel manager
    const messageSender: MessageSender = (_addr, payload) => fakeIndexer.pushPayload(payload);
    const channelManager = await TestChannelManager.create({...cmDefaultOpts, messageSender});

    // sync allocations
    await channelManager.syncAllocations([request(fakeIndexer.allocation(allocationId))]);

    expect(await channelManager.activeChannelCount(allocationId)).toEqual(2);

    // close allocations
    await channelManager.syncAllocations([]);
    expect(await channelManager.activeChannelCount(allocationId)).toEqual(0);

    // reopen allocations
    await channelManager.syncAllocations([request(fakeIndexer.allocation(allocationId))]);
    expect(await channelManager.activeChannelCount(allocationId)).toEqual(2); // now we should have more
  });

  // tests that the payment manager loads data from the wallet on startup
  test('restarting/bootstrapping', async () => {
    // setup fake indexer
    const fakeIndexer = new FakeIndexer({logger, privateKey: RECEIPT_PRIVATE_KEY});
    const allocationId = TEST_ALLOCATION.id;

    // setup channel manager
    const messageSender: MessageSender = (_addr, payload) => fakeIndexer.pushPayload(payload);
    const channelManager = await TestChannelManager.create({
      ...cmDefaultOpts,
      messageSender,
      syncOpeningChannelsMaxAttempts: 1
    });

    // block the indexer and syncAllocations
    fakeIndexer.goOffline();

    // sync allocations
    await channelManager.syncAllocations([request(fakeIndexer.allocation(allocationId))]);
    expect(await channelManager.activeChannelCount(allocationId)).toEqual(0);
    expect(channelManager.wallet.listenerCount('objectiveSucceeded')).toEqual(0);

    // Test that ensureObjective works when one outgoing message is dropped
    fakeIndexer.goOffline(1);
    const paymentManager = await TestPaymentManager.create({
      walletConfig,
      logger,
      cache
    });

    await expect(paymentManager.createPayment(TEST_PAYMENT)).rejects.toThrowError(
      'No free channels found'
    );

    // now leave the old channel manager to one side and start a new one
    const channelManager2 = await TestChannelManager.create({...cmDefaultOpts, messageSender});
    expect((await paymentWallet.getChannels()).channelResults).toHaveLength(2);
    await channelManager2.syncAllocations([request(fakeIndexer.allocation(allocationId))]);
    expect(channelManager2.wallet.listenerCount('objectiveSucceeded')).toEqual(0);

    // check it has created the correct payers
    expect(await channelManager2.activeChannelCount(allocationId)).toEqual(2);

    // Check that I can now create a payment
    await expect(paymentManager.createPayment(TEST_PAYMENT)).resolves.toMatchObject({
      signedStates: expect.any(Array)
    });

    expect(await (await paymentWallet.getChannels()).channelResults.length).toEqual(2);
  });
});
