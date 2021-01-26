import {Gauge} from 'prom-client';
import pMap from 'p-map';

import {Logger, Metrics, NetworkContracts} from '@graphprotocol/common-ts';

import {BN, makeDestination, Uint256} from '@statechannels/wallet-core';
import {Outgoing, Wallet as ChannelWallet} from '@statechannels/server-wallet';
import {ChannelResult, Participant} from '@statechannels/client-api-schema';
import {IncomingServerWalletConfig as WalletConfig} from '@statechannels/server-wallet';

import * as Insights from './insights';
import {Allocation, toAddress} from './query-engine-types';
import {ChannelCache, createPostgresCache} from './channel-cache';
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

import _ from 'lodash';
import {getAttestionAppByteCode} from '@graphprotocol/statechannels-contracts';
import {Evt} from 'evt';
import {BigNumber} from 'ethers';
import AsyncLock from 'async-lock';

export interface ChannelManagerOptions {
  logger: Logger;
  metrics?: Metrics;
  contracts: NetworkContracts;
  messageSender: (indexerUrl: string, payload: unknown) => Promise<unknown>;
  fundsPerAllocation: string;
  paymentChannelFundingAmount: string;
  cache?: ChannelCache;
  destinationAddress: string;
  useLedger?: boolean;
  fundingStrategy?: 'Direct' | 'Fake';
  syncOpeningChannelsPollIntervalMS?: number;
  syncOpeningChannelsMaxAttempts?: number;
  // Leaving this undefined means allocations are "ensured" (channels created) with infinite concurrency
  // This is not recommended -- it can overwhelm both the indexer and the gateway's DB
  ensureAllocationsConcurrency?: number;
  walletConfig: WalletConfig;

  /**
   * The amount of time (measured in MS) that a channel will take to be come finalized
   * after being registered on chain with a challenge.
   */
  onChainChallengeDuration?: {
    /**
     * The challenge duration for ledger channels. Defaults to 1 hour.
     */
    ledgerChannel?: number;
    /**
     * CURRENTLY NOT IMPORTANT!!
     * The finalization time for payment channels. Defaults to 10 minutes.
     */
    paymentChannel?: number;
  };
}
const DEFAULT_LEDGER_CHALLENGE_TIMEOUT = 3_600_000; // One hour
const DEFAULT_PAYMENT_CHALLENGE_TIMEOUT = 600_000; // 10 minutes

export type EnsureAllocationRequest = {
  allocation: Allocation;
  num: number;
  type: 'SetTo' | 'IncreaseBy' | 'ScaleBy';
};
export type ChannelRequest = {allocation: Allocation; capacity: number};

export type SyncChannelOpts = {limit?: number; allocationIds?: string[]};

export type ChannelManagementAPI = {
  // Channel creation/destruction
  ensureAllocations(requests: EnsureAllocationRequest[]): Promise<void>;
  syncAllocations(requests: EnsureAllocationRequest[]): Promise<void>;
  removeAllocations(allocationIds: string[]): Promise<void>;
  channelCount(allocationIds?: string[]): Promise<Record<string, number | undefined>>;

  //
  syncChannels(stalledFor: number, opts?: SyncChannelOpts): Promise<string[]>;

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
  private challengeDurations: {ledgerChannel: number; paymentChannel: number};

  private useLedger = false;

  // The way that the ledger is funded
  private fundingStrategy: 'Direct' | 'Fake';

  // This is used for polling on-chain funding status of ledger (if Direct)
  private syncOpeningChannelsPollIntervalMS: number;
  private syncOpeningChannelsMaxAttempts: number;
  private ensureAllocationsConcurrency: number | undefined;

  // Allows consumers to have insights into what's going on with the channel manager
  public channelInsights = Evt.create<Insights.ChannelManagerInsightEvent>();
  public channelsCreated = this.channelInsights.pipe(Insights.isChannelsCreated);
  public channelsReady = this.channelInsights.pipe(Insights.isChannelsReady);
  public channelsSynced = this.channelInsights.pipe(Insights.isChannelsSynced);
  public channelsRetired = this.channelInsights.pipe(Insights.isChannelsRetired);
  public channelsClosed = this.channelInsights.pipe(Insights.isChannelsClosed);

  static async create(opts: ChannelManagerOptions): Promise<ChannelManager> {
    const channelManager = new ChannelManager(await ChannelWallet.create(opts.walletConfig), opts);

    await channelManager.prepareDB();
    await channelManager.populateCache();

    return channelManager;
  }

  protected async populateCache(): Promise<void> {
    await this.cache.clearCache();
    const {channelResults} = await this.wallet.getChannels();

    this.logger.trace('Cache for payment channels being seeded from wallet database', {
      channelResults
    });

    const [ledgerChannels, paymentChannels] = _.partition(channelResults, isLedgerChannel);

    this.logger.debug('Cache repopulating from state channels database', {
      numRunning: paymentChannels.length,
      numLedger: ledgerChannels.length
    });

    await this.insertActiveChannels(paymentChannels);

    await pMap(
      ledgerChannels,
      ({channelId, allocations, fundingStatus, participants: [, {destination: allocationId}]}) => {
        if (fundingStatus !== 'Defunded')
          this.cache.insertLedgerChannel(
            convertBytes32ToAddress(allocationId),
            channelId,
            allocations
          );
      }
    );
  }

  constructor(wallet: ChannelWallet, opts: ChannelManagerOptions) {
    this.wallet = wallet;
    this.destinationAddress = opts.destinationAddress;
    this.fundsPerAllocation = BN.from(opts.fundsPerAllocation);
    this.paymentChannelFundingAmount = BN.from(opts.paymentChannelFundingAmount);

    if (BN.gt(this.paymentChannelFundingAmount, this.fundsPerAllocation))
      throw new Error(
        'Invalid arguments to ChannelManager. paymentChannelFundingAmount cannot exceed fundsPerAllocation'
      );

    this.logger = opts.logger.child({component: 'ChannelPaymentManager'});
    this.cache =
      opts.cache ?? createPostgresCache(opts.walletConfig.databaseConfiguration.connection);
    this.messageSender = opts.messageSender;
    if (opts.metrics) {
      this.registerMetrics(opts.metrics);
    }
    this.contracts = opts.contracts;
    this.fundingStrategy = opts.fundingStrategy ?? 'Fake';
    this.useLedger = opts.useLedger ?? false;
    this.syncOpeningChannelsPollIntervalMS = opts.syncOpeningChannelsPollIntervalMS || 2500;
    this.syncOpeningChannelsMaxAttempts = opts.syncOpeningChannelsMaxAttempts ?? 20;
    this.ensureAllocationsConcurrency = opts.ensureAllocationsConcurrency;
    this.maxCapacity = BigNumber.from(
      BN.div(this.fundsPerAllocation, this.paymentChannelFundingAmount)
    ).toNumber();

    const {onChainChallengeDuration: onChainFinalizationTime} = opts;
    this.challengeDurations = {
      ledgerChannel: onChainFinalizationTime?.ledgerChannel || DEFAULT_LEDGER_CHALLENGE_TIMEOUT,
      paymentChannel: onChainFinalizationTime?.paymentChannel || DEFAULT_PAYMENT_CHALLENGE_TIMEOUT
    };
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

    this.logger.info('Database migrations about to run for payment channels cache');
    try {
      await this.cache.initialize();
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
    this.logger.info('truncating DB');
    await this.wallet.dbAdmin().truncateDB();
    await this.cache.clearCache();
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

  public async syncChannels(stalledFor: number, opts?: SyncChannelOpts): Promise<string[]> {
    const syncChannelOpts = {
      limit: opts?.limit,
      contextIds: opts?.allocationIds
    };
    const stalledChannels = await this.cache.stalledChannels(stalledFor, syncChannelOpts);
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
          async ({outbox: [{params}], channelResult}) => {
            try {
              const {recipient, data} = params;

              const response = await this.messageSender(recipient, data).catch((err) =>
                this.logger.warn('Failed channel syncing handshake', {recipient, err})
              );

              if (!response) return;

              const {channelResults, outbox} = await this.wallet.pushMessage(response);

              if (outbox.length) {
                await this.exchangeMessagesUntilOutboxIsEmpty(outbox[0]).then((results) =>
                  this.insertActiveChannels(results)
                );
              }

              await pMap(
                channelResults.filter(
                  (channelResult) => channelResult.turnNum % 2 === 1 && channelResult.turnNum >= 3
                ),
                async (channelResult) => await this.cache.submitReceipt(channelResult)
              );

              return channelResults;
            } catch (err) {
              this.logger.error('Failed to sync channels with indexer', {err});

              const allocationId = extractAllocationId(channelResult);
              await this.cache.retireChannels(allocationId);

              return [];
            }
          },
          {concurrency: 4}
        ),
      {concurrency: 10}
    );

    const resumedChannels = _.compact(_.flatMapDeep(results));

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

  // can be used to ensure maximum concurrency of API calls e.g., syncAllocations
  private lock = new AsyncLock();

  // makes sure we have channels for the provided allocations, and close any other channels
  public async syncAllocations(requests: EnsureAllocationRequest[]): Promise<void> {
    await this.lock.acquire('syncAllocations', async () => {
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
    });
  }

  private async closeLedgersForAllocations(allocationIds: string[]): Promise<void> {
    this.logger.info('Removing allocations and withdrawing unspent funds', {allocationIds});

    const channelIds = _.flatten(
      await pMap(allocationIds, (allocationId) => this.cache.getLedgerChannels(allocationId))
    ).filter(notUndefined);

    if (channelIds.length > 0) {
      this.logger.debug('Closing ledger channels', {channelIds});

      const {outbox} = await this.wallet.closeChannels(channelIds);

      await pMap(outbox, (msg) => this.exchangeMessagesUntilOutboxIsEmpty(msg));

      await this.cache.removeLedgerChannels(channelIds);

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

  /**
   * Sends a message and pushes any response into the wallet and repeats until either
   * there is no longer a response or no longer anything left to send. Returns the
   * channel results from the last pushMessage call.
   */
  private async exchangeMessagesUntilOutboxIsEmpty(message: Outgoing): Promise<ChannelResult[]> {
    let outbox: Outgoing[] = [message];
    let channelResults: ChannelResult[] = [];

    while (outbox.length > 0) {
      if (outbox.length > 1) {
        /**
         * Sanity-check:
         *  Since the initial `message` has a since recipient, wallet behaviour implies that
         *  every response received back and any future pushMessage output also has just
         *  one recipient. Messages have unlimited size, too, and so each item in the outbox
         *  array is for a unique external recipient in general.
         */
        const error = 'Unreachable: exchangeMessagesUntilOutboxIsEmpty had > 1 outbox item';
        this.logger.error(error, {outbox});
        throw new Error(error);
      }

      const {
        params: {recipient, data}
      } = outbox.pop() as Outgoing;

      this.logger.trace(`Sending to indexer`, {toSend: summariseResponse(data)});

      const response = await this.messageSender(recipient, data).catch(
        // We don't have control over the message sender, and should therefore not
        // expect it to succeed. But, there's no good action to take right now, in
        // the presence of a caught error, so we suppress the error.
        (err) => this.logger.error('Unable to send message', {err, recipient, data})
      );

      if (response) {
        this.logger.trace('Received indexer response', summariseResponse(response));
        ({channelResults, outbox} = await this.wallet.pushMessage(response));
      }
    }

    return channelResults;
  }

  private async insertActiveChannels(channelResults: ChannelResult[]): Promise<void> {
    const active = _.filter(channelResults, (channel) => {
      if (isLedgerChannel(channel)) return false;

      return (
        channel.status === 'running' ||
        channel.status === 'proposed' ||
        channel.status === 'funding' ||
        channel.status === 'opening'
      );
    });

    if (active.length === 0) return;

    const grouped = _.groupBy(active, extractAllocationId);

    await Promise.all(
      _.map(grouped, async (channels, allocationId) => {
        await this.cache.insertChannels(allocationId, channels);
        const ready = channels.filter((c) => c.status === 'running');
        this.channelInsights.post(
          Insights.channelEvent('ChannelsReady', ready.map(extractSnapshot))
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

    if (!ledgerRunning && outbox.length === 1)
      await this.exchangeMessagesUntilOutboxIsEmpty(outbox[0]);

    return ledgerRunning;
  }

  private async createLedgerForAllocation(allocation: Allocation): Promise<ChannelResult> {
    const {id: allocationId} = allocation;

    this.logger.info(`Creating a ledger channel for allocation`, {allocationId});

    const participant = await this.participant();
    const {destination} = participant;

    const {
      outbox: [newLedgerMessage],
      channelResult
    } = await this.wallet.createLedgerChannel(
      {
        participants: [participant, allocationToParticipant(allocation)],
        challengeDuration: this.challengeDurations.ledgerChannel,
        allocations: [
          {
            assetHolderAddress: this.contracts.assetHolder.address,
            allocationItems: [
              {amount: this.fundsPerAllocation, destination},
              {amount: BN.from(0), destination: makeDestination(allocationId)}
            ]
          }
        ]
      },
      this.fundingStrategy
    );

    const {channelId, allocations} = channelResult;

    await this.cache.insertLedgerChannel(allocationId, channelId, allocations);

    this.logger.info(`Created ledger channel for allocation`, {channelId, allocationId});

    await this.exchangeMessagesUntilOutboxIsEmpty(newLedgerMessage);

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
    for (let i = 0; i < this.syncOpeningChannelsMaxAttempts; i++) {
      this.logger.info(`Polling receiver until ledger is funded`, {channelId, numAttempts: i});
      if (await this.syncOpeningLedgerChannel(channelId)) return true;
      await delay(this.syncOpeningChannelsPollIntervalMS);
    }

    this.logger.error(`Failed to receive countersigned ledger update.`, {channelId});
    return false;
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
    /**
     * Immediately sync ledger channel if one exists in case it is out of sync,
     * before checking activeChannels. This ensures capacity is accurate and avoid
     * erroneously creating more channels than are needed.
     */
    const ledger = await this.getLedgerForAllocation(allocation);
    if (ledger) {
      const {
        outbox: [syncLedger]
      } = await this.wallet.syncChannel({channelId: ledger.channelId});
      const channelResults = await this.exchangeMessagesUntilOutboxIsEmpty(syncLedger);
      await this.insertActiveChannels(channelResults);
    }

    const channelIds = await this.cache.activeChannels(allocation.id);

    if (BN.gt(capacity, this.maxCapacity)) {
      this.logger.warn('Cannot ensureAllocation at requested capacity', {
        maxCapacity: this.maxCapacity,
        capacity,
        requestedCapacity: capacity,
        fundsPerAllocation: this.fundsPerAllocation,
        paymentChannelFundingAmount: this.paymentChannelFundingAmount
      });
      capacity = Number(this.maxCapacity);
    }

    const needsSyncing = await this.cache.readyingChannels(allocation.id);
    if (needsSyncing.length > 0) await this.syncChannels(0, {allocationIds: [allocation.id]});

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
      this.paymentChannelFundingAmount,
      this.challengeDurations.paymentChannel
    );

    if (this.useLedger) {
      const {channelId: ledgerChannelId, status} =
        ledger || (await this.createLedgerForAllocation(allocation));

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
      await this.insertActiveChannels(channelResults);

      this.channelInsights.post(
        Insights.channelEvent('ChannelsCreated', channelResults.map(extractSnapshot))
      );
      this.logger.debug(`Channels created and being proposed to indexer`, {
        ledgerChannelId: startState.fundingLedgerChannelId,
        allocationId: allocation.id,
        channelIds: channelResults.map((c) => c.channelId)
      });

      await pMap(outbox, async (msg) => {
        const channelResults = await this.exchangeMessagesUntilOutboxIsEmpty(msg);
        await this.insertActiveChannels(channelResults);
      });
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
              await pMap(outbox, (msg) => this.exchangeMessagesUntilOutboxIsEmpty(msg));
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
    await this.cache.destroy();
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
