import {Address, AppData, fromJS, nullState, toJS, VariableAppData} from './app-data';
import {Allocation} from '@statechannels/client-api-schema';
import {BN, makeDestination} from '@statechannels/wallet-core';
import {BigNumber, constants as ethersConstants} from 'ethers';

type ReturnType = {appData: string; allocation: Allocation};
// TODO: These should probably be tested
export function toQueryRequested(
  appDataStr: string,
  allocation: Allocation,
  amount: BigNumber,
  requestCID: string,
  allocationId: Address
): ReturnType {
  const {constants} = toJS(appDataStr);

  const availableAmount = allocation.allocationItems[0].amount;

  if (BN.gt(amount, availableAmount))
    throw new Error(
      'AttestationApp: Cannot construct toQueryRequested, payment amount exceeds available budget'
    );

  const newAppData: AppData = {
    constants,
    variable: {
      allocationId,
      paymentAmount: amount.toHexString(),
      requestCID: requestCID,
      responseCID: ethersConstants.HashZero,
      signature: '0x'
    }
  };

  return {allocation, appData: fromJS(newAppData)};
}

export function toAttestationProvided(
  appDataStr: string,
  allocation: Allocation,
  responseCID: string,
  signature: string
): ReturnType {
  const {
    constants,
    variable: {requestCID, allocationId, paymentAmount}
  } = toJS(appDataStr);

  const variable: VariableAppData = {
    responseCID,
    signature,
    paymentAmount: BN.from(0),
    allocationId,
    requestCID
  };

  // Assume a single allocation for now
  const {
    assetHolderAddress,
    allocationItems: [gatewayItem, ...indexerItems]
  } = allocation;

  const destination = makeDestination(allocationId);
  const paymentIdx = indexerItems.findIndex((item) => item.destination === destination);

  if (paymentIdx === -1) indexerItems.push({destination, amount: BN.from(paymentAmount)});
  else indexerItems[paymentIdx].amount = BN.add(indexerItems[paymentIdx].amount, paymentAmount);

  const newAllocation: Allocation = {
    assetHolderAddress,
    allocationItems: [
      {destination: gatewayItem.destination, amount: BN.sub(gatewayItem.amount, paymentAmount)},
      ...indexerItems
    ]
  };
  return {appData: fromJS({constants, variable}), allocation: newAllocation};
}

export function toQueryDeclined(appDataStr: string, allocation: Allocation): ReturnType {
  const {constants} = toJS(appDataStr);
  const {variable} = nullState;

  return {appData: fromJS({constants, variable}), allocation};
}
