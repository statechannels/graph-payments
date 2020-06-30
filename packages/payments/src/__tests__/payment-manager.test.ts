process.env.SERVER_DB_NAME = 'payer';
process.env.SERVER_DB_HOST = 'localhost';
process.env.SERVER_DB_PORT = '5432';
process.env.SERVER_DB_USER = 'postgres';

/* eslint-disable @typescript-eslint/no-explicit-any */

import {NetworkContracts} from '@graphprotocol/common-ts';
import {FakeIndexer} from './fake-indexer';
import {TEST_ALLOCATION, TEST_PAYMENT} from './crash-test-dummies';

import * as fs from 'fs';

import {createTestLogger} from './setup';
import {constants} from 'ethers';
import {knex} from '../knexfile';
import {TestChannelManager} from './test-channel-manager';
import {MemoryCache, PostgresCache} from '../channel-cache';
import {TestPaymentManager} from './test-payment-manager';
import {ChannelManager} from '../channel-manager';
import {RECEIPT_PRIVATE_KEY} from '../../../e2e-testing/src/constants';
import {ChannelManagerInsightEvent} from '../insights';
import {ChannelManagerOptions} from '../../dist/channel-manager';
import {BN} from '@statechannels/wallet-core';
import {Allocation} from '../query-engine-types';
import {
  defaultTestConfig,
  overwriteConfigWithDatabaseConnection
} from '@statechannels/server-wallet/lib/src/config';

jest.setTimeout(30_000);
const DESTINATION_ADDRESS = '0xabc3F8C6836F01Fd39Cc1D1ca110F25D907Ce1CE';
const LOG_FILE = '/tmp/payment-manager-test.log';
// const LOG_FILE = undefined // turn off logging

// TODO: This was copied from development.env
// This should be cleaned up !!
const PAYMENT_MANAGER_CONNECTION =
  process.env.PAYMENT_MANAGER_CONNECTION || 'postgresql://postgres@localhost/payer';
const logger = createTestLogger(LOG_FILE).child({name: 'payment-manager'});
logger.level = 'debug';

const mockCollect = jest.fn(() => ({hash: constants.HashZero}));

const mockContracts = {
  assetHolder: {address: constants.AddressZero},
  attestationApp: {address: constants.AddressZero},
  staking: {
    collect: mockCollect as any
  },
  disputeManager: {address: constants.AddressZero}
} as NetworkContracts;
const walletConfig = overwriteConfigWithDatabaseConnection(
  defaultTestConfig,
  PAYMENT_MANAGER_CONNECTION
);
const cmDefaultOpts: Pick<
  ChannelManagerOptions,
  | 'logger'
  | 'contracts'
  | 'destinationAddress'
  | 'paymentChannelFundingAmount'
  | 'fundsPerAllocation'
  | 'walletConfig'
> = {
  logger,
  contracts: mockContracts,
  destinationAddress: DESTINATION_ADDRESS,
  paymentChannelFundingAmount: BN.from(1_000_000_000),
  fundsPerAllocation: BN.from(1_000_000_000_000),
  walletConfig
};

type MessageSender = ChannelManagerOptions['messageSender'];
async function dummyChannelManager(): Promise<ChannelManager> {
  const fakeIndexer = new FakeIndexer({logger, privateKey: RECEIPT_PRIVATE_KEY});

  const messageSender: MessageSender = (_addr, payload) => fakeIndexer.pushPayload(payload);

  return ChannelManager.create({...cmDefaultOpts, messageSender});
}
let dummyCM: ChannelManager;

beforeAll(async () => {
  dummyCM = await dummyChannelManager();
  await dummyCM.prepareDB();
  LOG_FILE && fs.existsSync(LOG_FILE) && fs.truncateSync(LOG_FILE);
});

beforeEach(async () => {
  logger.info(`Truncating ${process.env.SERVER_DB_NAME}`);
  await dummyCM.truncateDB();
});

afterAll(async () => {
  await dummyCM._shutdown();
  logger.info('Wallet knex destroyed');
  await knex.destroy();
  logger.info('knex destroyed');
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
    const cache = PostgresCache;
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
      const payment = await paymentManager.createPayment(allocationId, TEST_PAYMENT);
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

    logger.info('close db connections, so test exits ');
    await channelManager._shutdown();
    await paymentManager._shutdown();
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

    // close db connections, so test exits
    await channelManager._shutdown();
  });

  // tests that the payment manager loads data from the wallet on startup
  test('restarting/bootstrapping', async () => {
    // setup fake indexer
    const fakeIndexer = new FakeIndexer({logger, privateKey: RECEIPT_PRIVATE_KEY});
    const allocationId = TEST_ALLOCATION.id;

    // setup channel manager
    const cache = new MemoryCache();
    const messageSender: MessageSender = (_addr, payload) => fakeIndexer.pushPayload(payload);
    const channelManager = await TestChannelManager.create({
      ...cmDefaultOpts,
      messageSender,
      cache
    });
    const paymentManager = await TestPaymentManager.create({
      walletConfig,
      logger,
      cache: cache
    });

    // sync allocations
    await channelManager.syncAllocations([request(fakeIndexer.allocation(allocationId))]);
    expect(await channelManager.activeChannelCount(allocationId)).toEqual(2);

    // block the indexer and make a payment
    fakeIndexer.block();
    const payment = await paymentManager.createPayment(allocationId, TEST_PAYMENT);
    const result = fakeIndexer.pushPayload(payment);

    // now leave the old channel manager to one side and start a new one
    const channelManager2 = await TestChannelManager.create({...cmDefaultOpts, messageSender});

    // check it has created the correct payers
    expect(await channelManager2.activeChannelCount(allocationId)).toEqual(2);

    // finally unblock the indexer, so we can finish the test
    await fakeIndexer.unblock();
    await paymentManager.submitReceipt(await result);

    // close db connections, so test exits
    await channelManager._shutdown();
    await channelManager2._shutdown();
    await paymentManager._shutdown();
  });
});
