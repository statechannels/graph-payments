import {BN} from '@statechannels/wallet-core';
import {ethers, utils} from 'ethers';

const {AddressZero, HashZero} = ethers.constants;

export type Address = string & {_isAddress: void};

export const toAddress = (s: Address | string): Address =>
  typeof s === 'string' ? (utils.getAddress(s) as Address) : s;

export interface ConstantAppData {
  chainId: number;
  allocationId: Address;
  verifyingContract: string;
  subgraphDeploymentID: string;
}

interface VariableAppData {
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
      address allocationId,
      address verifyingContract,
      bytes32 subgraphDeploymentID
    ) constants,
    tuple(
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
      allocationId: withExtraProps.constants.allocationId,
      verifyingContract: withExtraProps.constants.verifyingContract,
      subgraphDeploymentID: withExtraProps.constants.subgraphDeploymentID
    },
    variable: {
      paymentAmount: withExtraProps.variable.paymentAmount.toHexString(),
      requestCID: withExtraProps.variable.requestCID,
      responseCID: withExtraProps.variable.responseCID,
      signature: withExtraProps.variable.signature
    }
  };
}

export function pureJSDecoder(appData: string): AppData {
  let cursor = 66; // 0x + 64 byte metadata
  const chainId = parseInt(appData.slice(cursor, cursor + 64), 16);
  cursor += 64;
  const allocationId = toAddress('0x' + appData.slice(cursor + 24, cursor + 64));
  cursor += 64;
  const verifyingContract = '0x' + appData.slice(cursor + 24, cursor + 64);
  cursor += 64;
  const subgraphDeploymentID = '0x' + appData.slice(cursor, cursor + 64);
  cursor += 64 + 64;
  const paymentAmount = BN.from('0x' + appData.slice(cursor, cursor + 64));
  cursor += 64;
  const requestCID = '0x' + appData.slice(cursor, cursor + 64);
  cursor += 64;
  const responseCID = '0x' + appData.slice(cursor, cursor + 64);
  cursor += 64 + 64;
  const sigLengthBytes = parseInt(appData.slice(cursor, cursor + 64), 16);
  cursor += 64;
  const signature = '0x' + appData.slice(cursor, cursor + sigLengthBytes * 2);

  return {
    constants: {chainId, allocationId, verifyingContract, subgraphDeploymentID},
    variable: {paymentAmount, requestCID, responseCID, signature}
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
    appData.constants.allocationId.substring(2).padStart(64, '0') + // remove '0x'
    appData.constants.verifyingContract.substring(2).padStart(64, '0') +
    appData.constants.subgraphDeploymentID.substring(2) +
    'a0'.padStart(64, '0') +
    BN.from(appData.variable.paymentAmount).substring(2).padStart(64, '0') +
    appData.variable.requestCID.substring(2).padStart(64, '0') +
    appData.variable.responseCID.substring(2).padStart(64, '0') +
    '80'.padStart(64, '0') +
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
    allocationId: toAddress(AddressZero),
    verifyingContract: AddressZero,
    subgraphDeploymentID: HashZero
  },
  variable: {
    paymentAmount: '0',
    requestCID: HashZero,
    responseCID: HashZero,
    signature: '0x'
  }
};
