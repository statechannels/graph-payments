import {AppData, fromJS, toJS} from './app-data';
import {Allocation} from '@statechannels/client-api-schema';
import {BN} from '@statechannels/wallet-core';
import _ from 'lodash';
import {BigNumber, constants} from 'ethers';

type ReturnType = {appData: string; allocations: Allocation[]};
// TODO: These should probably be tested
export function toQueryRequested(
  appDataStr: string,
  allocations: Allocation[],
  amount: BigNumber,
  requestCID: string
): ReturnType {
  const appData = toJS(appDataStr);

  const newAppData: AppData = {
    ...appData,
    variable: {
      ...appData.variable,

      paymentAmount: amount.toHexString(),
      requestCID: requestCID,
      responseCID: constants.HashZero,
      signature: '0x'
    }
  };

  return {allocations, appData: fromJS(newAppData)};
}

export function toAttestationProvided(
  appDataStr: string,
  allocations: Allocation[],
  responseCID: string,
  signature: string
): ReturnType {
  const appData = toJS(appDataStr);

  const newAppData: AppData = {
    ...appData,
    variable: {
      ...appData.variable,
      responseCID,
      signature
    }
  };

  // Assume a single allocation for now
  const {paymentAmount} = appData.variable;
  const firstAllocation = allocations[0];
  const newAllocations: Allocation[] = [
    {
      ...firstAllocation,
      allocationItems: [
        {
          ...firstAllocation.allocationItems[0],
          amount: BN.sub(firstAllocation.allocationItems[0].amount, paymentAmount)
        },
        {
          ...firstAllocation.allocationItems[1],
          amount: BN.add(firstAllocation.allocationItems[1].amount, paymentAmount)
        }
      ]
    }
  ];

  return {appData: fromJS(newAppData), allocations: newAllocations};
}

export function toQueryDeclined(appDataStr: string, allocations: Allocation[]): ReturnType {
  const appData = toJS(appDataStr);

  const newAppData: AppData = _.merge(appData, {
    variable: {
      requestCID: constants.HashZero,
      responseCID: constants.HashZero,
      signature: '0x'
    }
  });
  return {appData: fromJS(newAppData), allocations};
}
