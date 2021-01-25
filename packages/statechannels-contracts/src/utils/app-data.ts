import {BN} from '@statechannels/wallet-core';
import {BigNumber, ethers, utils} from 'ethers';

const {AddressZero, HashZero} = ethers.constants;

export type Address = string & {_isAddress: void};

export const toAddress = (s: Address | string): Address =>
  typeof s === 'string' ? (utils.getAddress(s) as Address) : s;

export interface ConstantAppData {
  chainId: number;
  verifyingContract: string;
  subgraphDeploymentID: string;
  // This is a uint256, but we know that it is less than 10_000
  // TODO: I considered using uint16 in the contract to save a bit of space, but I didn't know how that would affect the pureJS encoder/decoder
  maxAllocationItems: number;
}

export interface VariableAppData {
  allocationId: Address;
  paymentAmount: string;
  requestCID: string;
  responseCID: string;
  signature: string;
}

export interface AppData {
  constants: ConstantAppData;
  variable: VariableAppData;
}

const appDataSolidityEncoding = `
  tuple(
    tuple(
      uint256 chainId,
      address verifyingContract,
      bytes32 subgraphDeploymentID,
      uint16 maxAllocationItems
    ) constants,
    tuple(
      address allocationId,
      uint256 paymentAmount,
      bytes32 requestCID,
      bytes32 responseCID,
      bytes signature
    ) variable
  )
`;

export function abiEncoder(appData: AppData): string {
  return ethers.utils.defaultAbiCoder.encode([appDataSolidityEncoding], [appData]);
}

export function abiDecoder(appData: string): AppData {
  // The return value of decode contains is an array of fields. The array also contains named properties.
  // The logic below discards the array part of the object and only keeps named properties.
  // The logic below also provides runtime errors that will point to this function if the decoded object does not contain
  //   constants or variable properties
  const withExtraProps = ethers.utils.defaultAbiCoder.decode(
    [appDataSolidityEncoding],
    appData
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )[0] as any;
  return {
    constants: {
      chainId: withExtraProps.constants.chainId.toNumber(),
      verifyingContract: withExtraProps.constants.verifyingContract,
      subgraphDeploymentID: withExtraProps.constants.subgraphDeploymentID,
      maxAllocationItems: withExtraProps.constants.maxAllocationItems
    },
    variable: {
      allocationId: withExtraProps.variable.allocationId,
      paymentAmount: withExtraProps.variable.paymentAmount.toHexString(),
      requestCID: withExtraProps.variable.requestCID,
      responseCID: withExtraProps.variable.responseCID,
      signature: withExtraProps.variable.signature
    }
  };
}

export function pureJSDecoder(appData: string): AppData {
  let cursor = 66; // 0x + 64 byte metadata
  const chainId = parseInt(appData.slice(cursor, (cursor += 64)), 16);
  const verifyingContract = '0x' + appData.slice((cursor += 24), (cursor += 40));
  const subgraphDeploymentID = '0x' + appData.slice(cursor, (cursor += 64));
  const maxAllocationItems = BigNumber.from(
    '0x' + appData.slice(cursor, (cursor += 64))
  ).toNumber();

  cursor += 64;
  const allocationId = toAddress('0x' + appData.slice((cursor += 24), (cursor += 40)));
  const paymentAmount = BN.from('0x' + appData.slice(cursor, (cursor += 64)));
  const requestCID = '0x' + appData.slice(cursor, (cursor += 64));
  const responseCID = '0x' + appData.slice(cursor, (cursor += 64));

  cursor += 64;
  const sigLengthBytes = parseInt(appData.slice(cursor, (cursor += 64)), 16);
  const signature = '0x' + appData.slice(cursor, cursor + sigLengthBytes * 2);

  return {
    constants: {chainId, maxAllocationItems, verifyingContract, subgraphDeploymentID},
    variable: {allocationId, paymentAmount, requestCID, responseCID, signature}
  };
}

export const fromJS = pureJSEncoder;
export const toJS = pureJSDecoder;

export function pureJSEncoder(appData: AppData): string {
  const sigBytes = appData.variable.signature.substring(2).length / 2;
  const paddedSigLength = roundUpToNext32(sigBytes);
  return (
    '0x' +
    '20'.padStart(64, '0') +
    appData.constants.chainId.toString(16).padStart(64, '0') +
    appData.constants.verifyingContract.substring(2).padStart(64, '0') +
    appData.constants.subgraphDeploymentID.substring(2) +
    BN.from(appData.constants.maxAllocationItems).substring(2).padStart(64, '0') +
    'a0'.padStart(64, '0') +
    appData.variable.allocationId.substring(2).padStart(64, '0') + // remove '0x'
    BN.from(appData.variable.paymentAmount).substring(2).padStart(64, '0') +
    appData.variable.requestCID.substring(2).padStart(64, '0') +
    appData.variable.responseCID.substring(2).padStart(64, '0') +
    'a0'.padStart(64, '0') +
    sigBytes.toString(16).padStart(64, '0') +
    appData.variable.signature.substring(2).padEnd(paddedSigLength * 2, '0')
  );
}

function roundUpToNext32(len) {
  return Math.ceil(len / 32) * 32;
}

export const nullState: AppData = {
  constants: {
    chainId: 0,
    verifyingContract: AddressZero,
    subgraphDeploymentID: HashZero,
    maxAllocationItems: 0
  },
  variable: {
    allocationId: toAddress(AddressZero),
    paymentAmount: '0',
    requestCID: HashZero,
    responseCID: HashZero,
    signature: '0x'
  }
};
