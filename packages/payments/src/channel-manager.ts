import {Gauge} from 'prom-client';
import pMap from 'p-map';

import {Logger, Metrics, NetworkContracts} from '@graphprotocol/common-ts';

import {BN, makeDestination, Uint256} from '@statechannels/wallet-core';
import {Outgoing, Wallet as ChannelWallet} from '@statechannels/server-wallet';
import {ChannelResult, Participant} from '@statechannels/client-api-schema';
import {IncomingServerWalletConfig as WalletConfig} from '@statechannels/server-wallet/lib/src/config';

import * as Insights from './insights';
import {Allocation, toAddress} from './query-engine-types';
import {ChannelCache, MemoryCache} from './channel-cache';
import {
  summariseResponse,
  constructStartState,
  extractAllocationId,
  isLedgerChannel,
  delay,
  extractSnapshot,
  convertBytes32ToAddress,
  extractCapacity
} from './utils';
import {knex} from './knexfile';
import _ from 'lodash';
import {getAttestionAppByteCode} from '@graphprotocol/statechannels-contracts';
import {destroy} from './channel-cache/postgres-cache';
import {Evt} from 'evt';
import {BigNumber} from 'ethers';

export interface ChannelManagerOptions {
  logger: Logger;
  metrics?: Metrics;
  contracts: NetworkContracts;
  messageSender: (indexerUrl: string, payload: unknown) => Promise<unknown>;
  fundsPerAllocation: string;
  paymentChannelFundingAmount: string;
  cache?: ChannelCache;
  syncOpeningChannelsPollInterval?: number;
  destinationAddress: string;
  useLedger?: boolean;
  fundingStrategy?: 'Direct' | 'Fake';
  syncOpeningChannelsPollIntervalMS?: number;
  // Leaving this undefined means allocations are "ensured" (channels created) with infinite concurrency
  // This is not recommended -- it can overwhelm both the indexer and the gateway's DB
  ensureAllocationsConcurrency?: number;
  walletConfig: WalletConfig;
}

export type EnsureAllocationRequest = {
  allocation: Allocation;
  num: number;
  type: 'SetTo' | 'IncreaseBy' | 'ScaleBy';
};
export type ChannelRequest = {allocation: Allocation; capacity: number};

export type ChannelManagementAPI = {
  // Channel creation/destruction
  ensureAllocations(requests: EnsureAllocationRequest[]): Promise<void>;
  syncAllocations(requests: EnsureAllocationRequest[]): Promise<void>;
  removeAllocations(allocationIds: string[]): Promise<void>;
  channelCount(allocationIds?: string[]): Promise<Record<string, number | undefined>>;

  //
  syncChannels(stalledFor: number, limit?: number): Promise<string[]>;

  // Channel insights
  channelInsights: Evt<Insights.ChannelManagerInsightEvent>;
  channelsCreated: Evt<Insights.ChannelsCreated>;
  channelsReady: Evt<Insights.ChannelsReady>;
  channelsSynced: Evt<Insights.ChannelsSynced>;
  channelsRetired: Evt<Insights.ChannelsRetired>;
  channelsClosed: Evt<Insights.ChannelsClosed>;
};

export class ChannelManager implements ChannelManagementAPI {
  private logger: Logger;
  private wallet: ChannelWallet;
  private destinationAddress: string;
  protected cache: ChannelCache;
  private fundsPerAllocation: Uint256;
  private paymentChannelFundingAmount: Uint256;
  private messageSender: (indexerUrl: string, payload: unknown) => Promise<unknown>;
  private contracts: NetworkContracts;

  private useLedger = false;

  // The way that the ledger is funded
  private fundingStrategy: 'Direct' | 'Fake';

  // This is used for polling on-chain funding status of ledger (if Direct)
  private syncOpeningChannelsPollIntervalMS: number;
  private ensureAllocationsConcurrency: number | undefined;

  // Allows consumers to have insights into what's going on with the channel manager
  public channelInsights = Evt.create<Insights.ChannelManagerInsightEvent>();
  public channelsCreated = this.channelInsights.pipe(Insights.isChannelsCreated);
  public channelsReady = this.channelInsights.pipe(Insights.isChannelsReady);
  public channelsSynced = this.channelInsights.pipe(Insights.isChannelsSynced);
  public channelsRetired = this.channelInsights.pipe(Insights.isChannelsRetired);
  public channelsClosed = this.channelInsights.pipe(Insights.isChannelsClosed);

  static async create(opts: ChannelManagerOptions): Promise<ChannelManager> {
    const channelManager = new ChannelManager(opts);

    await channelManager.prepareDB();
    await channelManager.populateCache();

    return channelManager;
  }

  protected async populateCache(): Promise<void> {
    await knex.table('payment_manager.payment_channels').truncate();
    await knex.table('payment_manager.ledger_channels').truncate();

    const {channelResults} = await this.wallet.getChannels();

    this.logger.trace('Cache for payment channels being seeded from wallet database', {
      channelResults
    });

    const [ledgerChannels, paymentChannels] = _.partition(channelResults, isLedgerChannel);

    this.logger.debug('Cache repopulating from state channels database', {
      numRunning: paymentChannels.length,
      numLedger: ledgerChannels.length
    });

    await this.insertReadyChannels(paymentChannels);

    await pMap(ledgerChannels, ({channelId, participants: [, {destination: allocationId}]}) =>
      this.cache.insertLedgerChannel(convertBytes32ToAddress(allocationId), channelId)
    );
  }

  constructor(opts: ChannelManagerOptions) {
    this.destinationAddress = opts.destinationAddress;
    this.fundsPerAllocation = BN.from(opts.fundsPerAllocation);
    this.paymentChannelFundingAmount = BN.from(opts.paymentChannelFundingAmount);
    this.logger = opts.logger.child({component: 'ChannelPaymentManager'});
    this.wallet = ChannelWallet.create(opts.walletConfig);
    this.cache = opts.cache || new MemoryCache(this.logger);
    this.messageSender = opts.messageSender;
    if (opts.metrics) {
      this.registerMetrics(opts.metrics);
    }
    this.contracts = opts.contracts;
    this.fundingStrategy = opts.fundingStrategy ?? 'Fake';
    this.useLedger = opts.useLedger ?? false;
    this.syncOpeningChannelsPollIntervalMS = opts.syncOpeningChannelsPollIntervalMS || 2500;
    this.ensureAllocationsConcurrency = opts.ensureAllocationsConcurrency;
    this.maxCapacity = BigNumber.from(
      BN.div(this.fundsPerAllocation, this.paymentChannelFundingAmount)
    ).toNumber();
  }
  private maxCapacity: number;

  async prepareDB(): Promise<void> {
    this.logger.info('Database migrations starting for for wallet and cache');

    this.logger.info('Database migrations started for state channels wallet');
    await this.wallet
      .dbAdmin()
      .migrateDB()
      .catch((err) => {
        this.logger.error('Error migrating ', {err});
        throw err;
      });

    this.logger.info('Database schema creation for payment channels cache');
    await knex.raw('CREATE SCHEMA IF NOT EXISTS payment_manager');

    this.logger.info('Database migrations about to run for payment channels cache');
    try {
      await knex.migrate.latest();
    } catch (err) {
      this.logger.error('Error migrating', {err, config: this.wallet.walletConfig});
    }

    // TODO: We should only be registering this when we're not using a actual chain
    this.logger.info('Registering bytecode');
    await this.wallet.registerAppBytecode(
      this.contracts.attestationApp.address,
      getAttestionAppByteCode()
    );

    this.logger.info('Database migrations successfully finished for wallet and cache');
  }

  async truncateDB(): Promise<void> {
    await this.wallet.dbAdmin().truncateDB();
    await knex.raw(`TRUNCATE TABLE payment_manager.payment_channels CASCADE;`);
    await knex.raw(`TRUNCATE TABLE payment_manager.ledger_channels CASCADE;`);
  }

  // makes sure we have channels for the provided allocations
  public async ensureAllocations(requests: EnsureAllocationRequest[]): Promise<void> {
    const channelRequests = requests.map(
      extractCapacity(await this.cache.activeAllocations(), this.maxCapacity)
    );
    this.logger.debug('Ensuring allocations have required open payment channels', {
      requests: _.map(requests, collapseAllocation),
      channelRequests: _.map(channelRequests, collapseAllocation)
    });
    const concurrency = this.ensureAllocationsConcurrency;
    await pMap(channelRequests, (request) => this.ensureAllocation(request), {concurrency});
  }

  public async channelCount(allocationIds?: string[]): Promise<Record<string, number | undefined>> {
    return this.cache.activeAllocations(allocationIds);
  }

  public async syncChannels(stalledFor: number, limit?: number): Promise<string[]> {
    const stalledChannels = await this.cache.stalledChannels(stalledFor, limit);
    if (stalledChannels.length === 0) {
      return [];
    }

    this.logger.debug(`Calling sync channel on stalled channels`, {
      numChannels: stalledChannels.length,
      channels: stalledChannels
    });

    const syncOutput = await pMap(
      stalledChannels,
      (channelId) => this.wallet.syncChannel({channelId}),
      {concurrency: 5}
    );

    const groupedMessages = _.chain(syncOutput)
      .filter((output) => output.outbox?.length > 0)
      .groupBy((messages) => messages.outbox[0].params.recipient)
      .value();

    const results = await pMap(
      Object.values(groupedMessages),
      async (messages) =>
        pMap(
          messages,
          async (message) => {
            try {
              const {recipient, data} = this.wallet.mergeMessages([message]).outbox[0].params;

              const response = await this.messageSender(recipient, data);

              const {channelResults} = await this.wallet.pushMessage(response);

              await pMap(
                channelResults.filter((channelResult) => channelResult.turnNum % 2 === 1),
                async (channelResult) => await this.cache.submitReceipt(channelResult)
              );

              return channelResults;
            } catch (err) {
              this.logger.error('Failed to sync channels with indexer', {err});

              const allocationId = extractAllocationId(message.channelResult);
              await this.cache.retireChannels(allocationId);

              return [];
            }
          },
          {concurrency: 4}
        ),
      {concurrency: 10}
    );

    const resumedChannels = _.flatMapDeep(results.filter(notUndefined));

    this.channelInsights.post(
      Insights.channelEvent('ChannelsSynced', resumedChannels.map(extractSnapshot))
    );

    this.logger.debug(`Resumed stalled channels successfully`, {
      numChannels: resumedChannels.length,
      channels: resumedChannels.map((c) => c.channelId)
    });

    return resumedChannels.map((cr) => cr.channelId);
  }

  public async removeAllocations(allocationIds: string[]): Promise<void> {
    const channelsRetiredEvent: Insights.ChannelsRetired = {type: 'ChannelsRetired', report: {}};
    await pMap(
      allocationIds,
      async (allocationId) => {
        const {amount, channelIds} = await this.cache.retireChannels(allocationId);
        channelsRetiredEvent.report[allocationId] = {allocationId, amount, channelIds};
      },
      {concurrency: 4}
    );

    this.channelInsights.post(channelsRetiredEvent);

    // this will only close channels where it is currently our turn
    // it will close _any_ retired channels - not just those from this allocation
    // we might want to decide to call this periodically, instead of triggering here
    await this.closeRetired();

    if (this.useLedger) await this.closeLedgersForAllocations(allocationIds);
  }

  // makes sure we have channels for the provided allocations, and close any other channels
  public async syncAllocations(requests: EnsureAllocationRequest[]): Promise<void> {
    const channelRequests = requests.map(
      extractCapacity(await this.cache.activeAllocations(), this.maxCapacity)
    );
    this.logger.debug('Syncing allocations', {
      requests: _.map(requests, (request) => ({...request, allocation: request.allocation.id})),
      channelRequests
    });

    const activeAllocations = await this.cache.activeAllocations();
    const allocationsWeHave = Object.keys(activeAllocations);
    const allocationsWeNeed = requests.map(({allocation}) => allocation.id as string);
    const allocationsToClose = allocationsWeHave.filter((id) => !allocationsWeNeed.includes(id));

    await Promise.all([
      this.ensureAllocations(_.uniq(requests)),
      this.removeAllocations(_.uniq(allocationsToClose))
    ]);
  }

  private async closeLedgersForAllocations(allocationIds: string[]): Promise<void> {
    this.logger.info('Removing allocations and withdrawing unspent funds', {allocationIds});

    const channelIds = (
      await pMap(allocationIds, (allocationId) => this.cache.getLedgerChannel(allocationId))
    ).filter(notUndefined);

    if (channelIds.length > 0) {
      this.logger.debug('Closing ledger channels', {channelIds});

      const {outbox} = await this.wallet.closeChannels(channelIds);
      await this.cache.removeLedgerChannels(channelIds);

      await pMap(outbox, ({params: {recipient, data}}) => this.messageSender(recipient, data));

      this.channelInsights.post({type: 'ChannelsClosed', channelIds});
      this.logger.debug('Closed ledger channels', {channelIds});
      this.logger.info('Removed allocations successfully', {allocationIds});
    }
  }

  private async participant(): Promise<Participant> {
    const signingAddress = await this.wallet.getSigningAddress();
    return {
      signingAddress,
      destination: makeDestination(this.destinationAddress),
      // TODO: The gateway should probably choose a participantId based on its instance
      participantId: signingAddress
    };
  }

  private async sendMessages(outbox: Outgoing[]): Promise<void> {
    await Promise.all(outbox.map(async (item) => this.sendMessage(item.params)));
  }

  private async sendMessage({recipient, data}: Outgoing['params']): Promise<void> {
    const response = await this.messageSender(recipient, data).catch(() => {
      // We don't have control over the message sender, and should therefore not
      // expect it to succeed.
      // But, there's no good action to take right now, in the presence of a caught
      // error
    });
    if (response) await this.handleResponse(response);
  }

  private async handleResponse(response: unknown) {
    this.logger.trace('Received indexer response', summariseResponse(response));

    const {channelResults, outbox: newOutbox} = await this.wallet.pushMessage(response);

    if (newOutbox.length > 0)
      this.logger.trace(`Sending back to indexer`, {
        toSend: summariseResponse(newOutbox[0].params.data)
      });

    await this.sendMessages(newOutbox);

    await this.insertReadyChannels(channelResults);
  }

  private async insertReadyChannels(channelResults: ChannelResult[]): Promise<void> {
    const readyChannels = _.filter(
      channelResults,
      (channel) => channel.status === 'running' && !isLedgerChannel(channel)
    );

    if (readyChannels.length === 0) return;

    const grouped = _.groupBy(readyChannels, extractAllocationId);

    await Promise.all(
      _.map(grouped, async (channels, allocationId) => {
        await this.cache.insertChannels(allocationId, channels);
        this.channelInsights.post(
          Insights.channelEvent('ChannelsReady', channels.map(extractSnapshot))
        );
      })
    );
  }

  private async syncOpeningLedgerChannel(channelId: string): Promise<boolean> {
    const {
      outbox,
      channelResult: {status}
    } = await this.wallet.syncChannel({channelId});
    const ledgerRunning = status === 'running';
    if (!ledgerRunning) await this.sendMessages(outbox);
    return ledgerRunning;
  }

  private async createLedgerForAllocation(allocation: Allocation) {
    this.logger.info(`Creating a ledger channel for allocation`, {
      allocation: allocation.id
    });

    const participant = await this.participant();
    const {destination} = participant;

    const {outbox, channelResult} = await this.wallet.createLedgerChannel(
      {
        participants: [participant, allocationToParticipant(allocation)],
        allocations: [
          {
            assetHolderAddress: this.contracts.assetHolder.address,
            allocationItems: [
              {amount: this.fundsPerAllocation, destination},
              {amount: BN.from(0), destination: makeDestination(allocation.id)}
            ]
          }
        ]
      },
      this.fundingStrategy
    );

    await this.cache.insertLedgerChannel(allocation.id, channelResult.channelId);

    this.logger.info(`Created ledger channel for allocation`, {
      allocation: allocation.id,
      channelId: channelResult.channelId
    });

    await this.sendMessages(outbox);

    return channelResult;
  }

  private async pollReceiverUntilLedgerCountersigned(channelId: string): Promise<boolean> {
    // Why is this needed? Consider the following scenario for directly funded ledger channel:
    //
    // 1. The channel manager sends a postfund1 message to the receipt manager.
    // 2. The receipt manager has NOT received the chain notification about updated funding.
    // 3. The receipt manager does NOT reply with postfund2
    //
    // Below, the channel manager polls the receipt manager with the latest channel state until
    // the receipt manager replies with postfund2
    let syncSuccessful = false;
    let numAttempts = 0;

    while (!syncSuccessful && numAttempts++ < 20) {
      this.logger.info(`Polling receiver until ledger is funded`, {channelId, numAttempts});
      syncSuccessful = await this.syncOpeningLedgerChannel(channelId);
      await delay(this.syncOpeningChannelsPollIntervalMS);
    }

    if (!syncSuccessful)
      this.logger.error(`Failed to receive countersigned ledger update.`, {channelId});

    return syncSuccessful;
  }

  private async getLedgerForAllocation(allocation: Allocation): Promise<ChannelResult | undefined> {
    const participant = await this.participant();

    const {channelResults} = await this.wallet.getLedgerChannels(
      this.contracts.assetHolder.address,
      [participant, allocationToParticipant(allocation)]
    );

    if (
      channelResults &&
      channelResults.length > 0 &&
      ['proposed', 'opening', 'funding', 'running'].includes(channelResults[0].status)
    )
      return channelResults[0];
  }

  private async ensureAllocation({allocation, capacity}: ChannelRequest): Promise<void> {
    const channelIds = await this.cache.activeChannels(allocation.id);

    const channelsRequired = capacity - channelIds.length;
    if (channelsRequired <= 0) {
      // don't close down channels at the moment
      return;
    }

    const participant = await this.participant();
    const startState = constructStartState(
      participant,
      allocation,
      this.useLedger ? 'Ledger' : 'Fake',
      toAddress(this.contracts.assetHolder.address),
      toAddress(this.contracts.attestationApp.address),
      toAddress(this.contracts.disputeManager.address),
      this.wallet.walletConfig.networkConfiguration.chainNetworkID,
      this.paymentChannelFundingAmount
    );

    if (this.useLedger) {
      const {channelId: ledgerChannelId, status} =
        (await this.getLedgerForAllocation(allocation)) ||
        (await this.createLedgerForAllocation(allocation));

      const isLedgerFunded =
        status === 'running' || (await this.pollReceiverUntilLedgerCountersigned(ledgerChannelId));

      if (!isLedgerFunded) {
        this.logger.error(`Channels not created due to lack of funding from counterparty`, {
          allocationId: allocation.id,
          ledgerChannelId
        });
        return;
      }

      this.logger.info(`Channels being created`, {
        ledgerChannelId,
        allocationId: allocation.id,
        capacity,
        channelsRequired
      });

      startState.fundingLedgerChannelId = ledgerChannelId;
    }

    // TODO: Should 50 be configurable here?
    await pMap(_.chunk(_.range(channelsRequired), 50), async (channelsToCreate) => {
      const numChannels = channelsToCreate.length;

      const {channelResults, outbox} = await this.wallet.createChannels(startState, numChannels);

      this.channelInsights.post(
        Insights.channelEvent('ChannelsCreated', channelResults.map(extractSnapshot))
      );
      this.logger.debug(`Channels created and being proposed to indexer`, {
        ledgerChannelId: startState.fundingLedgerChannelId,
        allocationId: allocation.id,
        channelIds: channelResults.map((c) => c.channelId)
      });

      await this.sendMessages(outbox);
    });
  }

  public async closeRetired(): Promise<void> {
    // select channels that are both retired and our turn
    const groupedChannelIds = await this.cache.closableChannels();

    await pMap(
      _.values(groupedChannelIds),
      (_channelIds) =>
        pMap(
          _.chunk(_channelIds, 50),
          async (channelIds) => {
            if (channelIds.length > 0) {
              this.logger.debug('Closing channels', {channelIds});
              const {outbox} = await this.wallet.closeChannels(channelIds);
              this.channelInsights.post({type: 'ChannelsClosed', channelIds});
              await this.cache.removeChannels(channelIds);
              await this.sendMessages(outbox);
            }
          },
          {concurrency: 6}
        ),
      {concurrency: 6}
    );
  }

  private registerMetrics(metrics: Metrics): ChannelManagerMetrics {
    return {
      runningChannels: new metrics.client.Gauge({
        name: 'payment_manager_running_channels',
        help: 'Total number of running channels for allocation',
        labelNames: ['allocation'],
        registers: [metrics.registry]
      }),
      usableChannels: new metrics.client.Gauge({
        name: 'payment_manager_usable_channels',
        help: 'Total number of usable channels for allocation',
        labelNames: ['allocation'],
        registers: [metrics.registry]
      }),
      lockedChannels: new metrics.client.Gauge({
        name: 'payment_manager_locked_channels',
        help: 'Total number of locked channels for allocation',
        labelNames: ['allocation'],
        registers: [metrics.registry]
      }),
      busyChannels: new metrics.client.Gauge({
        name: 'payment_manager_busy_channels',
        help: 'Total number of busy channels for allocation',
        labelNames: ['allocation'],
        registers: [metrics.registry]
      }),
      stalledChannels: new metrics.client.Gauge({
        name: 'payment_manager_stalled_channels',
        help: 'Total number of stalled channels for allocation (busy for 10secs)',
        labelNames: ['allocation'],
        registers: [metrics.registry]
      })
    };
  }

  public async _closeDBConnections(): Promise<void> {
    this.logger.debug('Closing wallet db connections');
    await this.wallet.destroy();

    this.logger.debug('closing postgres cache connection');
    await destroy();
  }

  public async _shutdown(): Promise<void> {
    await this._closeDBConnections();
  }
}

interface ChannelManagerMetrics {
  runningChannels: Gauge<string>;
  usableChannels: Gauge<string>;
  lockedChannels: Gauge<string>;
  busyChannels: Gauge<string>;
  stalledChannels: Gauge<string>;
}

function allocationToParticipant(allocation: Allocation): Participant {
  return {
    participantId: allocation.indexer.url,
    destination: makeDestination(allocation.id),
    signingAddress: allocation.indexer.id
  };
}

function notUndefined<T>(x: T | undefined): x is T {
  return x !== undefined;
}

// For logging purposes, we just want to log the allocation id
function collapseAllocation<T extends {allocation: Allocation}>(t: T) {
  return {...t, allocation: t.allocation.id};
}
