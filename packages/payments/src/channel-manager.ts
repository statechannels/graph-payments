import {Gauge} from 'prom-client';
import pMap from 'p-map';
import {Logger, Metrics, NetworkContracts} from '@graphprotocol/common-ts';
import {BN, makeDestination, Uint256} from '@statechannels/wallet-core';
import {
  DBAdmin,
  Outgoing,
  Wallet as ChannelWallet,
  IncomingServerWalletConfig as WalletConfig
} from '@statechannels/server-wallet';
import {ChannelResult, Participant} from '@statechannels/client-api-schema';
import _ from 'lodash';
import {getAttestionAppByteCode} from '@graphprotocol/statechannels-contracts';
import {Evt} from 'evt';
import {BigNumber} from 'ethers';
import AsyncLock from 'async-lock';
import {DBObjective} from '@statechannels/server-wallet/lib/src/models/objective';

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
import {ChannelCache, createPostgresCache} from './channel-cache';
import {Allocation, toAddress} from './query-engine-types';
import * as Insights from './insights';

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

  backoffStrategy: {
    initialDelay: number;
    numAttempts: number;
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
    await DBAdmin.migrateDatabase(opts.walletConfig);

    const channelManager = new ChannelManager(await ChannelWallet.create(opts.walletConfig), opts);
    // TODO: We should only be registering this when we're not using a actual chain
    opts.logger.info('Registering bytecode');
    await channelManager.wallet.registerAppBytecode(
      opts.contracts.attestationApp.address,
      getAttestionAppByteCode()
    );

    await channelManager.cache.initialize();
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

  private backoffIntervals: number[];

  constructor(wallet: ChannelWallet, opts: ChannelManagerOptions) {
    this.wallet = wallet;
    this.destinationAddress = opts.destinationAddress;
    this.fundsPerAllocation = BN.from(opts.fundsPerAllocation);
    this.paymentChannelFundingAmount = BN.from(opts.paymentChannelFundingAmount);
    this.backoffIntervals = _.range(opts.backoffStrategy.numAttempts).map(
      (i) => opts.backoffStrategy.initialDelay * 2 ** i
    );

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

  async truncateDB(): Promise<void> {
    this.logger.info('truncating DB');
    await DBAdmin.truncateDatabase(this.wallet.walletConfig);
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
    const stalledChannels = await this.cache.stalledChannels(stalledFor, {
      limit: opts?.limit,
      contextIds: opts?.allocationIds
    });

    return stalledChannels.length === 0
      ? []
      : this._syncChannels(stalledChannels).then((results) => _.map(results, 'channelId'));
  }

  private async _syncChannels(channelIds: string[]): Promise<ChannelResult[]> {
    const syncOutput = await pMap(channelIds, (channelId) => this.wallet.syncChannel({channelId}), {
      concurrency: 5
    });

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

    const channelResults = _.compact(_.flatMapDeep(results));

    this.channelInsights.post(
      Insights.channelEvent('ChannelsSynced', channelResults.map(extractSnapshot))
    );

    const [resumedChannels, stillStalled] = _.partition(
      channelResults,
      (channelResult) => channelResult.turnNum % 2 === 1 && channelResult.turnNum >= 3
    );

    if (resumedChannels.length)
      this.logger.debug(`Resumed stalled channels successfully`, {
        numChannels: resumedChannels.length,
        channels: resumedChannels.map((c) => c.channelId)
      });

    if (stillStalled.length)
      this.logger.debug(`Some channels still stalled after syncing attempt`, {
        numChannels: stillStalled.length,
        channels: stillStalled.map((c) => c.channelId)
      });

    return channelResults;
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
   *
   * @param objectiveIds objectiveIds to sync on
   * @param message initial message to send to indexer
   *
   * 1. exchanges messages until outbox is empty
   * 2. if any objectives have not finished, waits for a period of time,
   *    and then sync the in progress objectives
   */
  private async ensureObjectives(
    objectives: DBObjective[],
    initialMessage: Outgoing
  ): Promise<ChannelResult[]> {
    const remaining = new Map(objectives.map((o) => [o.objectiveId, o]));

    objectives.map(({objectiveId}) =>
      this.wallet.on('objectiveSucceeded', (o) => {
        if (o.objectiveId === objectiveId) {
          remaining.delete(objectiveId);
        }
      })
    );

    const results = await this.exchangeMessagesUntilOutboxIsEmpty(initialMessage);
    const latestResult = new Map(results.map((c) => [c.channelId, c]));

    for (const retryTimeoutMs of this.backoffIntervals) {
      if (remaining.size === 0) return Array.from(latestResult.values());

      await delay(retryTimeoutMs);

      const newResults = await this._syncChannels(
        Array.from(remaining.values()).map((o) => o.data.targetChannelId)
      );
      newResults.map((c) => latestResult.set(c.channelId, c));
    }

    throw new Error('Unable to ensure objectives');
  }

  /**
   *
   * @param message initial message to send to indexer
   *
   * exchanges messages until outbox is empty
   * if any resulting channels are not yet 'running', waits for a period of time,
   * and then s yncs all channels for the resulting allocation
   */
  private async ensureChannelsOpen(initialMessage: Outgoing): Promise<ChannelResult[]> {
    const running: Record<string, ChannelResult> = {};
    const notRunning: Record<string, ChannelResult> = {};

    let results = await this.exchangeMessagesUntilOutboxIsEmpty(initialMessage);

    for (const retryTimeoutMs of [2_500, 5_000, 10_000, 20_000, 40_000]) {
      const [nowRunning, stillNotRunning] = _.partition(results, ['status', 'running']);

      nowRunning.forEach((c) => {
        running[c.channelId] = c;
        delete notRunning[c.channelId];
      });

      stillNotRunning.forEach((c) => (notRunning[c.channelId] = c));

      if (_.values(notRunning).length === 0) return _.values(running);

      this.logger.debug('Channels not yet opened, will try syncing after a timeout', {
        notRunningChannelIds: _.map(notRunning, 'channelId'),
        retryTimeoutMs
      });

      await delay(retryTimeoutMs);

      results = await this._syncChannels(_.keys(notRunning));
    }

    throw new Error('Unable to ensure channels open');
  }

  /**
   * Sends a message and pushes any response into the wallet and repeats until either
   * there is no longer a response or no longer anything left to send.
   *
   * Collects the channel results from the each pushMessage call, and returns the latest result
   * for each channel
   */
  private async exchangeMessagesUntilOutboxIsEmpty(message: Outgoing): Promise<ChannelResult[]> {
    let outbox: Outgoing[] = [message];

    // :warning: the freshness of the latest result relies on the wallet not "work stealing"
    // across multiple concurrent "run loop" iterations. I do not believe that to be an issue
    // here.
    const latestResult: Record<string, ChannelResult> = {};

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
        const result = await this.wallet.pushMessage(response);
        result.channelResults.map((r) => (latestResult[r.channelId] = r));
        outbox = result.outbox;
      }
    }

    return Object.values(latestResult);
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
    const {maxCapacity, fundsPerAllocation, paymentChannelFundingAmount} = this;

    const ledger = await this.getLedgerForAllocation(allocation);

    const channelIds = await this.cache.activeChannels(allocation.id);

    if (BN.gt(capacity, maxCapacity)) {
      this.logger.warn('Cannot ensureAllocation at requested capacity', {
        maxCapacity,
        capacity,
        fundsPerAllocation,
        paymentChannelFundingAmount
      });
      capacity = Number(maxCapacity);
    }

    const needsSyncing = await this.cache.readyingChannels(allocation.id);
    if (needsSyncing.length > 0) await this.syncChannels(0, {allocationIds: [allocation.id]});

    const channelsRequired = capacity - channelIds.length;
    if (channelsRequired <= 0) {
      // We intentionally don't close down excess channels
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
      paymentChannelFundingAmount,
      this.challengeDurations.paymentChannel
    );

    if (this.useLedger) {
      const {channelId: ledgerChannelId} =
        ledger || (await this.createLedgerForAllocation(allocation));

      const result = await this.wallet.syncChannel({channelId: ledgerChannelId});

      try {
        await this.ensureChannelsOpen(result.outbox[0]);
      } catch (err) {
        this.logger.error('Failed to ensure ledger channel reached a running / open state', {
          ledgerChannelId,
          err
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

      const {channelResults, outbox, newObjectives} = await this.wallet.createChannels(
        startState,
        numChannels
      );

      if (outbox.length !== 1) {
        this.logger.error('Unexpected outbox length, expected 1', {channelsToCreate, outbox});
        throw new Error('Unexpected outbox length, expected 1');
      }

      const channelIds = _.map(channelResults, 'channelId');

      this.channelInsights.post(
        Insights.channelEvent('ChannelsCreated', channelResults.map(extractSnapshot))
      );

      this.logger.debug(`Channels created and being proposed to indexer`, {
        ledgerChannelId: startState.fundingLedgerChannelId,
        allocationId: allocation.id,
        channelIds
      });

      try {
        const readyResults = await this.ensureObjectives(newObjectives, outbox[0]);
        await this.insertActiveChannels(readyResults);
      } catch (err) {
        this.logger.error('Failed to ensure payment channels reached a running / open state', {
          channelIds,
          err
        });
        return;
      }
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
