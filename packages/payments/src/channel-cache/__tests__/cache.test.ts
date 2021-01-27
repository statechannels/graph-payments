import {Address, toAddress} from '@graphprotocol/common-ts';
import {fromJS, nullState} from '@graphprotocol/statechannels-contracts';
import {ChannelResult} from '@statechannels/client-api-schema';

import {CACHE_TEST_DB_CONNECTION_STRING, createTestLogger} from '../../__tests__/setup';
import {ChannelSnapshot} from '../../types';
import {createPostgresCache} from '../postgres-cache';
import {BigNumber} from 'ethers';
import _ from 'lodash';
import Knex from 'knex';
import {createKnex, migrateCacheDB} from '../../db/utils';
import {makeDestination} from '@statechannels/wallet-core';

const baseLogger = createTestLogger('/tmp/channel-cache.log');
baseLogger.level = 'debug';
let knex: Knex;
const cache = createPostgresCache(CACHE_TEST_DB_CONNECTION_STRING);
const logger = baseLogger.child({test: 'Postgres cache'});

10_000;
const doNothing = async (snapshot: ChannelSnapshot) => ({snapshot, result: undefined});
beforeAll(async () => {
  knex = createKnex(CACHE_TEST_DB_CONNECTION_STRING);
  await migrateCacheDB(knex);

  await knex.table('payment_manager.payment_channels').truncate();
  await knex.table('payment_manager.ledger_channels').truncate();
});
afterAll(async () => {
  await knex.destroy();
});
// TODO: Now that we don't have the memory cache this test seems pretty ugly :(
test('various cache tests', async () => {
  logger.info('create a couple of channels');
  const result = await cache.insertChannels(allocation0.id, [allocation0.channel0.state3]);
  expect(result).toHaveLength(1);
  expect(result).toContain(allocation0.channel0.id);
  // Inserting the same result the second time should not return the channel id
  expect(await cache.insertChannels(allocation0.id, [allocation0.channel0.state3])).toHaveLength(0);
  await cache.insertChannels(allocation1.id, [
    allocation1.channel1.state0,
    allocation1.channel2.state0
  ]);

  logger.info('expect some active channels');

  expect(await cache.activeChannels(allocation0.id)).toMatchObject([allocation0.channel0.id]);
  expect((await cache.activeChannels(allocation1.id)).sort()).toMatchObject([
    allocation1.channel1.id,
    allocation1.channel2.id
  ]);

  expect(await cache.activeAllocations()).toMatchObject({[allocation0.id]: 1, [allocation1.id]: 2});
  const specificActive = await cache.activeAllocations([allocation0.id]);
  expect(specificActive[allocation0.id]).toEqual(1);
  expect(specificActive[allocation1.id]).toBeUndefined();

  logger.info('check we can acquire');
  await cache.acquireChannel(allocation0.id, async (snapshot) => {
    const {channelId} = snapshot;
    logger.info('channel acquired', {snapshot});
    expect(channelId).toEqual(allocation0.channel0.id);
    logger.info("check we can't acquire again while channel is locked");
    await expect(cache.acquireChannel(allocation0.id, doNothing)).rejects.toThrowError(
      /No free channels/
    );

    return {snapshot, result: undefined};
  });

  logger.info('check we can re-acquire');

  let stalledId = '';
  await cache.acquireChannel(allocation0.id, async (snapshot) => {
    const {channelId} = snapshot;
    stalledId = channelId;
    expect(channelId).toEqual(allocation0.channel0.id);

    return {
      snapshot: {...snapshot, turnNum: snapshot.turnNum + 1, indexerBal: BigNumber.from('0x03')},
      result: undefined
    };
  });
  expect(await cache.stalledChannels(0, {limit: 1})).toEqual([stalledId]);
  expect(await cache.stalledChannels(0, {limit: 0})).toHaveLength(0);
  expect(await cache.stalledChannels(0, {contextIds: [allocation0.id]})).toHaveLength(1);
  expect(await cache.stalledChannels(0, {contextIds: [allocation1.id]})).toHaveLength(0);

  await cache.acquireChannel(allocation1.id, async (snapshot) => {
    const {channelId} = snapshot;
    expect([allocation1.channel1.id, allocation1.channel2.id]).toContain(channelId);

    return {snapshot, result: undefined};
  });
  expect((await cache.activeChannels(allocation1.id)).sort()).toMatchObject([
    allocation1.channel1.id,
    allocation1.channel2.id
  ]);
  logger.info('check that the channel not updated does not appear stalled');
  expect(await cache.stalledChannels(0, {})).toEqual([stalledId]);

  logger.info('check that we can retire channels');
  await expect(cache.retireChannels(allocation0.id)).resolves.toEqual({
    amount: '0x03',
    channelIds: [allocation0.channel0.id]
  });
  await expect(cache.activeChannels(allocation0.id)).resolves.toHaveLength(0);
  let closable = await cache.closableChannels();
  expect(closable[allocation0.id]).toEqual([allocation0.channel0.id]);

  await expect(cache.removeChannels([allocation0.channel0.id])).resolves.not.toThrow();
  closable = await cache.closableChannels();
  expect(closable[allocation0.id]).not.toBeDefined();

  expect((await cache.activeChannels(allocation1.id)).sort()).toMatchObject([
    allocation1.channel1.id,
    allocation1.channel2.id
  ]);
  expect(closable[allocation1.id]).not.toBeDefined();
  expect(await cache.activeAllocations()).toMatchObject({[allocation1.id]: 2});

  closable = await cache.closableChannels();
  expect(closable[allocation1.id]).not.toBeDefined();
  await expect(cache.retireChannels(allocation1.id)).resolves.toEqual({
    amount: '0x00',
    channelIds: expect.any(Array)
  });

  closable = await cache.closableChannels();
  expect(closable[allocation1.id]).toHaveLength(2);

  await expect(cache.removeChannels(closable[allocation1.id])).resolves.not.toThrow();
  closable = await cache.closableChannels();
  expect(closable[allocation1.id]).toBeUndefined();

  await expect(cache.activeChannels(allocation1.id)).resolves.toHaveLength(0);
  // TODO: expect(await cache.activeAllocations()).toMatchObject({[allocation1.id]: 2});
  expect(cache.acquireChannel(allocation1.id, doNothing)).rejects.toThrowError(/No free channels/);

  logger.info('check we can remove channels');
  await cache.removeChannels([allocation0.channel0.id]);
  // TODO: expect(await cache.activeAllocations()).toMatchObject({[allocation1.id]: 2});
});

test('cache can store and retrieve initial ledger state info', async () => {
  const channelId = allocation1.channel1.id;
  const allocationId = allocationId1;
  const {allocations} = allocation1.channel1.state0;

  await cache.insertLedgerChannel(allocationId, channelId, allocations);

  const result = await cache.getInitialLedgerStateInfo(channelId);

  expect(result.outcome).toMatchObject(allocations);
});

const allocationId0 = toAddress('0x0000000000000000000000000000000000000000');
const allocation0 = {
  id: allocationId0,
  channel0: {
    id: 'channel0',
    state3: buildChannel('channel0', allocationId0, 3),
    state5: buildChannel('channel0', allocationId0, 5)
  }
};

const allocationId1 = toAddress('0x1111111111111111111111111111111111111111');
const allocation1 = {
  id: allocationId1,
  channel1: {
    id: 'channel1',
    state0: buildChannel('channel1', allocationId1, 3)
  },
  channel2: {
    id: 'channel2',
    state0: buildChannel('channel2', allocationId1, 3)
  }
};

function buildChannel(channelId: string, allocationId: Address, turnNum: number): ChannelResult {
  return {
    fundingStatus: 'Funded',
    adjudicatorStatus: 'Open',
    participants: [
      {
        participantId: 'gateway',
        signingAddress: '0x',
        destination: '0xgateway'
      },
      {
        participantId: 'indexer',
        signingAddress: '0x',
        destination: `0x${allocationId}`
      }
    ],
    allocations: [
      {
        assetHolderAddress: '0xtoken',
        allocationItems: [
          {destination: '0xgateway', amount: '0xa'},
          {destination: makeDestination(allocationId), amount: '0x0'}
        ]
      }
    ],
    appData: fromJS(_.merge(nullState, {constants: {allocationId}})),
    appDefinition: '0xapp',
    channelId,
    status: 'running',
    turnNum
  };
}
