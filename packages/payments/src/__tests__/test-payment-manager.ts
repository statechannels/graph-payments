import {PaymentManager, PaymentManagerOptions} from '../payment-manager';

export class TestPaymentManager extends PaymentManager {
  static async create(opts: PaymentManagerOptions): Promise<TestPaymentManager> {
    const channelManager = new TestPaymentManager(opts);
    return channelManager;
  }

  public async _closeDBConnections(): Promise<void> {
    this.logger.debug('Closing wallet db connections');
    return this.wallet.destroy();
  }

  public async _shutdown(): Promise<void> {
    await this._closeDBConnections();
  }
}
