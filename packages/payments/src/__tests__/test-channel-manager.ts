import {getAttestionAppByteCode} from '@graphprotocol/statechannels-contracts';
import {DBAdmin, Wallet} from '@statechannels/server-wallet';

import {ChannelManager, ChannelManagerOptions} from '../channel-manager';

export class TestChannelManager extends ChannelManager {
  async activeChannelCount(allocationId: string): Promise<number> {
    return (await this.cache.activeChannels(allocationId)).length;
  }
  async ledgerChannelExists(allocationId: string): Promise<boolean> {
    const ret = await this.cache.getLedgerChannels(allocationId);
    return ret.length > 0;
  }
  constructor(public wallet: Wallet, opts: ChannelManagerOptions) {
    super(wallet, opts);
  }
  static async create(opts: ChannelManagerOptions): Promise<TestChannelManager> {
    await DBAdmin.migrateDatabase(opts.walletConfig);
    const wallet = await Wallet.create(opts.walletConfig);
    await wallet.registerAppBytecode(
      opts.contracts.attestationApp.address,
      getAttestionAppByteCode()
    );
    const channelManager = new TestChannelManager(wallet, opts);

    await channelManager.cache.initialize();

    return channelManager;
  }
}
