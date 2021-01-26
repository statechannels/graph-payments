import {ChannelResult} from '@statechannels/client-api-schema';
import {DBAdmin, Wallet} from '@statechannels/server-wallet';
import {Logger, NetworkContracts} from '@graphprotocol/common-ts';
import {
  toAttestationProvided,
  toQueryDeclined,
  getAttestionAppByteCode
} from '@graphprotocol/statechannels-contracts';
import _ from 'lodash';
import {constants, ethers} from 'ethers';
import {IncomingServerWalletConfig as WalletConfig} from '@statechannels/server-wallet';
import {extractSnapshot, isLedgerChannel, summarisePayload} from './utils';

interface ReceiptManagerInterface {
  migrateWalletDB(): Promise<void>;
  inputStateChannelMessage(payload: unknown): Promise<void | unknown>;
  provideAttestation(
    payload: unknown,
    attestation: {responseCID: string; signature: string}
  ): Promise<unknown>;
  declineQuery(payload: unknown): Promise<unknown>;
}

class RMError extends Error {
  constructor(errorMessage: string) {
    super(`ReceiptManager: ${errorMessage}`);
  }
}
export class ReceiptManager implements ReceiptManagerInterface {
  private wallet: Wallet;
  async create(
    logger: Logger,
    privateKey: string,
    contracts: NetworkContracts,
    walletConfig: WalletConfig
  ): Promise<ReceiptManager> {
    return new ReceiptManager(logger, privateKey, contracts, await Wallet.create(walletConfig));
  }
  constructor(
    private logger: Logger,
    public privateKey: string,
    private readonly contracts: NetworkContracts,
    wallet: Wallet
  ) {
    this.wallet = wallet;
    this.wallet.warmUpThreads();
  }

  async migrateWalletDB(): Promise<void> {
    this.logger.info('Migrate server-wallet database');
    await DBAdmin.migrateDatabase(this.wallet.walletConfig);
    // TODO: We should only be registering this when we're not using a actual chain
    await this.wallet.registerAppBytecode(
      this.contracts.attestationApp.address,
      getAttestionAppByteCode()
    );

    try {
      const {address} = new ethers.Wallet(this.privateKey);
      await this.wallet.knex.table('signing_wallets').insert({
        private_key: this.privateKey,
        address
      });
    } catch (err) {
      if (err.constraint !== 'signing_wallets_private_key_unique') {
        throw err;
      }
    }

    this.logger.info('Successfully migrated server-wallet database');
  }

  async truncateDB(tables?: string[]): Promise<void> {
    return DBAdmin.truncateDatabase(this.wallet.walletConfig, tables);
  }

  async closeDBConnections(): Promise<void> {
    return this.wallet.destroy();
  }

  public async signingAddress(): Promise<string> {
    return this.wallet.getSigningAddress();
  }

  async inputStateChannelMessage(payload: unknown): Promise<void | unknown> {
    this.logger.debug('Payload received', summarisePayload(payload));
    const results = await this.wallet.pushMessage(payload);
    const pushMessageResults = results;
    const {channelResults} = pushMessageResults;
    this.logger.debug(
      'Payload pushed',
      channelResults.filter((r) => !isLedgerChannel(r)).map(extractSnapshot)
    );

    const proposedChannels = channelResults.filter((cr: ChannelResult) => cr.status === 'proposed');
    const runningChannels = channelResults.filter(
      (cr: ChannelResult) => cr.status === 'running' && !isLedgerChannel(cr)
    );
    const closedChannels = channelResults.filter((cr: ChannelResult) => cr.status === 'closed');

    const updatedResults = _.compact([
      pushMessageResults,
      await this.handleProposedChannel(proposedChannels),
      await this.handleRunningChannels(runningChannels),
      await this.handleClosedChannels(closedChannels)
    ]);

    const {outbox} = Wallet.mergeOutputs(updatedResults);
    // TODO: We should filter out all messages except those for the specific recipient
    if (outbox.length == 1) {
      return outbox[0].params.data;
    } else if (outbox.length > 1) {
      throw new Error('Too many outbox items');
    }
  }

  private async handleProposedChannel(channels: ChannelResult[]) {
    /**
     * Initial request to create a channelResult is received. In this case, join
     * the channel.
     */
    if (channels.length > 0) {
      this.logger.debug('Channel proposals detected. Joining channels.', {
        channelIds: channels.map((cr) => cr.channelId)
      });

      const usingGRTAssetHolder = ({allocations: [{assetHolderAddress}]}: ChannelResult) =>
        assetHolderAddress === this.contracts.assetHolder.address;

      const usingAttestationAppOrLedger = ({appDefinition}: ChannelResult) =>
        appDefinition === this.contracts.attestationApp.address ||
        appDefinition === constants.AddressZero; // ledger channel uses "null app"

      const [rightAsset, wrongAsset] = _.partition(channels, usingGRTAssetHolder);
      const [rightApp, wrongApp] = _.partition(channels, usingAttestationAppOrLedger);
      const channelIds = _.intersection(
        _.map(rightAsset, 'channelId'),
        _.map(rightApp, 'channelId')
      );

      // TODO: Channel validation
      const joinChannelMessage = await this.wallet.joinChannels(channelIds);

      this.logger.info(`Channels joined successfully`, {channelIds});

      if (wrongAsset.length > 0)
        this.logger.warn(`Channels ignored not using GRTAssetHolder`, {
          channels: wrongAsset.map(({channelId, allocations: [{assetHolderAddress}]}) => ({
            channelId,
            assetHolderAddress
          }))
        });

      if (wrongApp.length > 0)
        this.logger.warn(`Channels ignored not using AttestationApp`, {
          channels: wrongApp.map(({channelId, appDefinition}) => ({
            channelId,
            appDefinition
          }))
        });

      return joinChannelMessage;
    }
  }

  private async handleRunningChannels(channels: ChannelResult[]) {
    const ourTurn = (c: ChannelResult) => c.turnNum % 2 === 0;

    const ourTurnChannels = channels.filter(ourTurn);
    const notOurTurnChannels = channels.filter((c) => !ourTurn(c));

    if (ourTurnChannels.length > 0) {
      this.logger.warn(`Found channels that are on our turn. Declining queries.`, {
        numChannels: ourTurnChannels.length,
        channels: ourTurnChannels.map((c) => c.channelId)
      });
      // TODO: Why is this a valid assumption?
      // We assume any channel on our turn from inputStateChannelMessage come from a SyncChannels and should be declined
      // If the gateway is malicious its possible it could cause issues by calling SyncChannels at the same time the query comes through
      // but we assume the gateway won't do that
      const results = await Promise.all(
        ourTurnChannels.map((c) => {
          const {appData, allocation} = toQueryDeclined(c.appData, c.allocations[0]);
          const allocations = [allocation];
          return this.wallet.updateChannel({channelId: c.channelId, appData, allocations});
        })
      );

      return Wallet.mergeOutputs(results);
    } else if (notOurTurnChannels.length > 0) {
      this.logger.debug(`Ignoring running channels that aren't on our turn.`, {
        numChannels: notOurTurnChannels.length,
        channels: notOurTurnChannels.map((c) => c.channelId)
      });
      return undefined;
    } else return undefined;
  }

  private async handleClosedChannels(closedChannels: ChannelResult[]) {
    if (closedChannels.length > 0) {
      this.logger.info('Ignoring closed channels', {
        channels: closedChannels.map((c) => c.channelId)
      });
    }
    return undefined;
  }

  async provideAttestation(
    payload: unknown,
    attestation: {responseCID: string; signature: string}
  ): Promise<unknown> {
    this.logger.debug('Payment received', summarisePayload(payload));

    const channelResult = await this._pushMessage(payload);

    const {appData: prevAppData, allocations: prevAllocations} = channelResult;

    this.logger.debug('Payment pushed', extractSnapshot(channelResult));

    const {allocation, appData} = toAttestationProvided(
      prevAppData,
      prevAllocations[0],
      attestation.responseCID,
      attestation.signature
    );

    this.logger.debug('Attestation signed', {
      allocationid: allocation.allocationItems[1].destination,
      ...attestation
    });

    const {
      outbox: [{params: outboundMsg}]
    } = await this.wallet.updateChannel({
      channelId: channelResult.channelId,
      appData,
      allocations: [allocation]
    });

    this.logger.debug(
      'Attestation embedded in state channel update',
      extractSnapshot(channelResult)
    );

    return outboundMsg.data;
  }

  async declineQuery(payload: unknown): Promise<unknown> {
    this.logger.debug('Payment received', summarisePayload(payload));

    const channelResult = await this._pushMessage(payload);

    const {appData: prevAppData, allocations: prevAllocations} = channelResult;

    this.logger.debug('Payment pushed', extractSnapshot(channelResult));

    const {allocation, appData} = toQueryDeclined(prevAppData, prevAllocations[0]);

    this.logger.debug('Query decline state created', {channel: channelResult.channelId});

    const {
      outbox: [{params: outboundMsg}]
    } = await this.wallet.updateChannel({
      channelId: channelResult.channelId,
      appData,
      allocations: [allocation]
    });

    this.logger.debug(
      'Query decline embedded in state channel update',
      extractSnapshot(channelResult)
    );

    return outboundMsg.data;
  }

  private async _pushMessage(payload: unknown): Promise<ChannelResult> {
    const {
      channelResults: [channelResult],
      outbox: pushMessageOutbox
    } = await this.wallet.pushMessage(payload);
    if (pushMessageOutbox.length > 0) {
      throw new RMError('Did not expect any outbox items');
    }
    return channelResult;
  }
}
