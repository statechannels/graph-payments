import {Wallet} from '@statechannels/server-wallet';
import {PaymentManager, PaymentManagerOptions} from '../payment-manager';

export class TestPaymentManager extends PaymentManager {
  constructor(wallet: Wallet, opts: PaymentManagerOptions) {
    super(wallet, opts);
  }

  static async create(opts: PaymentManagerOptions): Promise<TestPaymentManager> {
    const channelManager = new TestPaymentManager(await Wallet.create(opts.walletConfig), opts);
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
