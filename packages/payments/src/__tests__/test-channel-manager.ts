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
  constructor(wallet: Wallet, opts: ChannelManagerOptions) {
    super(wallet, opts);
  }
  static async create(opts: ChannelManagerOptions): Promise<TestChannelManager> {
    await DBAdmin.migrateDatabase(opts.walletConfig);
    const channelManager = new TestChannelManager(await Wallet.create(opts.walletConfig), opts);
    await channelManager.prepareDB();
    await channelManager.populateCache();

    return channelManager;
  }
}
