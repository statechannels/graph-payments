import {Histogram, Counter} from 'prom-client';
import {Logger, Metrics, timed} from '@graphprotocol/common-ts';
import {
  Wallet as ChannelWallet,
  IncomingServerWalletConfig as WalletConfig,
  MultiThreadedWallet
} from '@statechannels/server-wallet';
import {Evt} from 'evt';

import {ConditionalPayment} from './query-engine-types';
import {ChannelQueryResponse} from './types';
import * as Insights from './insights';
import {
  constructPaymentUpdate,
  summariseResponse,
  extractSnapshot,
  extractQueryResponse,
  extractAllocationId
} from './utils';
import {CacheUserAPI} from './channel-cache/types';
import {PaymentManagerInsightEvent} from './insights';
import {createPostgresCache} from './channel-cache';

export interface PaymentManagerOptions {
  logger: Logger;
  metrics?: Metrics;
  cache?: CacheUserAPI;
  walletConfig: WalletConfig;
}

export type PaymentManagementAPI = {
  createPayment(payment: ConditionalPayment): Promise<unknown>;
  submitReceipt(payload: unknown): Promise<ChannelQueryResponse>;

  paymentInsights: Evt<PaymentManagerInsightEvent>;
};

export class PaymentManager implements PaymentManagementAPI {
  protected logger: Logger;
  private metrics?: PaymentManagerMetrics;
  protected wallet: ChannelWallet;
  protected cache: CacheUserAPI;

  static async create(opts: PaymentManagerOptions): Promise<PaymentManagementAPI> {
    const paymentManager = new PaymentManager(await ChannelWallet.create(opts.walletConfig), opts);
    paymentManager.wallet instanceof MultiThreadedWallet &&
      (await paymentManager.wallet.warmUpThreads());
    return paymentManager;
  }

  public paymentInsights = Evt.create<PaymentManagerInsightEvent>();
  public paymentCreated = this.paymentInsights.pipe(Insights.isPaymentCreated);
  public paymentFailed = this.paymentInsights.pipe(Insights.isPaymentFailed);
  public receiptSubmitted = this.paymentInsights.pipe(Insights.isReceiptSubmitted);

  constructor(wallet: ChannelWallet, opts: PaymentManagerOptions) {
    this.logger = opts.logger.child({component: 'ChannelPaymentManager'});
    this.wallet = wallet;
    this.cache =
      opts.cache ?? createPostgresCache(opts.walletConfig.databaseConfiguration.connection);
    if (opts.metrics) {
      this.metrics = this.registerMetrics(opts.metrics);
      this.addMetricsTimers();
    }
  }

  public async createPayment(payment: ConditionalPayment): Promise<unknown> {
    const {allocationId} = payment;

    this.logger.debug(`Creating payment`, {allocationId});
    // find a channel from the cache

    return await this.cache
      .acquireChannel(allocationId, async (snapshot) => {
        const {channelId} = snapshot;
        this.logger.debug(`Channel acquired for payment`, {
          allocationId,
          channelId
        });
        this.metrics?.createPaymentSuccess.inc({allocation: allocationId});

        // make a payment in that channel
        const {allocations, appData} = constructPaymentUpdate(payment, snapshot);
        // update the channel: if we've done the caching/locking right, this should never throw.
        // Errors are therefore programming/logic errors, so we don't bother catching
        const {channelResult: updatedChannel, outbox} = await this.wallet.updateChannel({
          channelId,
          allocations,
          appData
        });

        const updatedSnapshot = extractSnapshot(updatedChannel);

        if (outbox.length !== 1) {
          return {
            snapshot: updatedSnapshot,
            result: new Error(
              `Creating payments resulted in ${outbox.length} new messages. Expecting exactly 1.`
            )
          };
        }

        const paymentPayload = outbox[0].params.data;

        const {
          turnNum,
          outcome: [outcome]
        } = updatedSnapshot;
        this.paymentInsights.post({
          type: 'PaymentCreated',
          payment,
          allocation: allocationId,
          channel: {channelId, turnNum, outcome, contextId: allocationId}
        });
        return {result: paymentPayload, snapshot: updatedSnapshot};
      })
      .catch((err) => {
        this.paymentInsights.post({type: 'PaymentFailed', allocation: allocationId, err});
        if (err.message === 'No free channels found')
          throw new PaymentManagerError(Errors.noFreeChannels, allocationId);
        else throw err;
      });
  }

  async submitReceipt(payload: unknown): Promise<ChannelQueryResponse> {
    this.logger.debug(`Accepting response`, summariseResponse(payload));

    // just push it into wallet
    const {outbox, channelResults} = await this.wallet.pushMessage(payload);

    // check that it's what we're expecting
    if (outbox.length !== 0) {
      const err = new Error(`Accepting response led to non-empty outbox`);
      this.logger.error(`Accepting response led to non-empty outbox`, {
        payload,
        outbox,
        err
      });
      throw err;
    }
    if (channelResults.length !== 1) {
      const err = new Error(`Accepting response didn't lead to exactly one channel result`);
      this.logger.error(`Accepting response didn't lead to exactly one channel result`, {
        length: channelResults.length,
        channelResults,
        payload,
        err
      });
      throw err;
    }
    const result = channelResults[0];

    // update the cache
    await this.cache.submitReceipt(result);

    const {
      allocations: [outcome],
      turnNum,
      channelId
    } = result;
    this.paymentInsights.post({
      type: 'ReceiptSubmitted',
      allocation: extractAllocationId(result),
      channel: {channelId, turnNum, outcome, contextId: extractAllocationId(result)}
    });

    return extractQueryResponse(result);
  }

  private addMetricsTimers(): void {
    const _createPayment = this.createPayment.bind(this);
    this.createPayment = (payment: ConditionalPayment) => {
      return timed(
        this.metrics?.createPaymentDuration,
        {allocation: payment.allocationId},
        _createPayment(payment)
      );
    };
    const _submitReceipt = this.submitReceipt.bind(this);
    this.submitReceipt = (payload: unknown) => {
      return timed(this.metrics?.submitReceiptDuration, {}, _submitReceipt(payload));
    };
  }

  private registerMetrics(metrics: Metrics): PaymentManagerMetrics {
    return {
      createPaymentSuccess: new metrics.client.Counter({
        name: 'payment_manager_create_payment_success',
        help: 'Number of successful payment creations',
        labelNames: ['allocation'],
        registers: [metrics.registry]
      }),
      createPaymentFailure: new metrics.client.Counter({
        name: 'payment_manager_create_payment_failure',
        help: 'Number of failed payment creations',
        labelNames: ['allocation'],
        registers: [metrics.registry]
      }),
      createPaymentDuration: new metrics.client.Histogram({
        name: 'payment_manager_create_payment_duration',
        help: 'Duration of create payment call',
        labelNames: ['allocation'],
        registers: [metrics.registry]
      }),
      submitReceiptDuration: new metrics.client.Histogram({
        name: 'payment_manager_submit_receipt_duration',
        help: 'Duration of submit receipt',
        labelNames: [],
        registers: [metrics.registry]
      })
    };
  }
}

interface PaymentManagerMetrics {
  createPaymentSuccess: Counter<string>;
  createPaymentFailure: Counter<string>;
  createPaymentDuration: Histogram<string>;
  submitReceiptDuration: Histogram<string>;
}

export enum Errors {
  noFreeChannels = 'No free channels found'
}
export class PaymentManagerError extends Error {
  constructor(reason: Errors, public readonly allocationId: string) {
    super(reason);
  }
}
