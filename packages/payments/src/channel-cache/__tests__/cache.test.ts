import {Address, toAddress} from '@graphprotocol/common-ts';
import {fromJS, nullState} from '@graphprotocol/statechannels-contracts';
import {ChannelResult} from '@statechannels/client-api-schema';

import {createTestLogger} from '../../__tests__/setup';
import {ChannelCache} from '../types';
import pino from 'pino';
import {ChannelSnapshot} from '../../types';
import {PostgresCache} from '../postgres-cache';
import {knex} from '../../knexfile';
import {BigNumber} from 'ethers';
import _ from 'lodash';

const baseLogger = createTestLogger('/tmp/channel-cache.log');
baseLogger.level = 'debug';

const doNothing = async (snapshot: ChannelSnapshot) => ({snapshot, result: undefined});
beforeAll(async () => {
  await knex.migrate.latest();
  await knex.table('payment_manager.payment_channels').truncate();
});
afterAll(async () => {
  await knex.destroy();
});

const testCacheImplementation = (cache: ChannelCache, logger: pino.Logger) => async (): Promise<
  void
> => {
  logger.info('create a couple of channels');
  await cache.insertChannels(allocation0.id, [allocation0.channel0.state3]);
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
  expect(await cache.stalledChannels(0, 1)).toEqual([stalledId]);

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
  expect(await cache.stalledChannels(0)).toEqual([stalledId]);

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
};

test(
  'Postgres cache',
  testCacheImplementation(PostgresCache, baseLogger.child({test: 'Postgres cache'})),
  10_000
);

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
          {destination: `0x${allocationId}`, amount: '0x0'}
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
