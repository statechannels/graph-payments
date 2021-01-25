import {ChannelManager, ChannelManagerOptions} from '../channel-manager';

export class TestChannelManager extends ChannelManager {
  async activeChannelCount(allocationId: string): Promise<number> {
    return (await this.cache.activeChannels(allocationId)).length;
  }
  async ledgerChannelExists(allocationId: string): Promise<boolean> {
    const ret = await this.cache.getLedgerChannels(allocationId);
    return ret.length > 0;
  }
  static async create(opts: ChannelManagerOptions): Promise<TestChannelManager> {
    const channelManager = new TestChannelManager(opts);
    await channelManager.prepareDB();
    await channelManager.populateCache();
    return channelManager;
  }
}
