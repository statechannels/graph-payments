/* SPDX-License-Identifier: UNLICENSED */

pragma solidity ^0.7.4;
pragma experimental ABIEncoderV2;

import '@statechannels/nitro-protocol/contracts/interfaces/ForceMoveApp.sol';
import '@statechannels/nitro-protocol/contracts/Outcome.sol';
import '@openzeppelin/contracts/cryptography/ECDSA.sol';
import '@openzeppelin/contracts/math/SafeMath.sol';

contract AttestationApp is ForceMoveApp {
    using SafeMath for uint256;

    struct ConstantAppData {
        uint256 chainId;
        address allocationId;
        address verifyingContract;
        bytes32 subgraphDeploymentID;
    }

    struct VariableAppData {
        uint256 paymentAmount;
        bytes32 requestCID;
        bytes32 responseCID;
        bytes signature;
    }

    struct AttestationAppData {
        ConstantAppData constants;
        VariableAppData variable;
    }

    uint256 constant PARTICIPANT_GATEWAY = 0;
    uint256 constant PARTICIPANT_INDEXER = 1;

    function validTransition(
        VariablePart calldata a,
        VariablePart calldata b,
        uint48 turnNumB,
        uint256 nParticipants
    ) external override pure returns (bool) {
        // BEGIN COPY: Copied from SingleAssetPayments.sol
        // https://github.com/statechannels/statechannels/blob/ee1a0aa/packages/nitro-protocol/contracts/examples/SingleAssetPayments.sol
        Outcome.OutcomeItem[] memory outcomeA = abi.decode(a.outcome, (Outcome.OutcomeItem[]));
        Outcome.OutcomeItem[] memory outcomeB = abi.decode(b.outcome, (Outcome.OutcomeItem[]));

        // Throws if more than one asset
        require(outcomeA.length == 1, 'outcomeA: Only one asset allowed');
        require(outcomeB.length == 1, 'outcomeB: Only one asset allowed');

        // Throws unless the assetoutcome is an allocation
        Outcome.AssetOutcome memory assetOutcomeA = abi.decode(
            outcomeA[0].assetOutcomeBytes,
            (Outcome.AssetOutcome)
        );
        Outcome.AssetOutcome memory assetOutcomeB = abi.decode(
            outcomeB[0].assetOutcomeBytes,
            (Outcome.AssetOutcome)
        );

        require(
            assetOutcomeA.assetOutcomeType == uint8(Outcome.AssetOutcomeType.Allocation),
            'outcomeA: AssetOutcomeType must be Allocation'
        );
        require(
            assetOutcomeB.assetOutcomeType == uint8(Outcome.AssetOutcomeType.Allocation),
            'outcomeB: AssetOutcomeType must be Allocation'
        );

        // Throws unless that allocation has exactly n outcomes
        Outcome.AllocationItem[] memory allocationA = abi.decode(
            assetOutcomeA.allocationOrGuaranteeBytes,
            (Outcome.AllocationItem[])
        );
        Outcome.AllocationItem[] memory allocationB = abi.decode(
            assetOutcomeB.allocationOrGuaranteeBytes,
            (Outcome.AllocationItem[])
        );
        require(
            allocationA.length == nParticipants,
            'outcomeA: Allocation length must equal number of participants'
        );
        require(
            allocationB.length == nParticipants,
            'outcomeB: Allocation length must equal number of participants'
        );
        // END COPY

        require(nParticipants == 2, 'Must be a 2-party channels');

        AttestationAppData memory providedStateA = abi.decode(a.appData, (AttestationAppData));
        AttestationAppData memory providedStateB = abi.decode(b.appData, (AttestationAppData));

        // Validate the constants
        require(
            _bytesEqual(abi.encode(providedStateA.constants),abi.encode(providedStateB.constants)),
            'Constants must not change'
        );

        // Next validate the variable parts
        if (turnNumB % 2 == PARTICIPANT_GATEWAY) {
            require(
                providedStateB.variable.requestCID != 0,
                'Gateway Query: RequestCID must be non-zero'
            );
            require(
                providedStateB.variable.responseCID == 0,
                'Gateway Query: ResponseCID must be zero'
            );

            require(
                isZero(providedStateB.variable.signature),
                'Gateway Query: Signature must be zero'
            );
            require(
                providedStateB.variable.paymentAmount > 0,
                'Gateway Query: Payment amount must be non-zero'
            );
        } else {
            // Indexer moved

            // If there is a non-zero responseCID the attestation has been provided
            if (providedStateB.variable.responseCID > 0) {
                require(
                    recoverAttestationSigner(providedStateB) ==
                        providedStateB.constants.allocationId,
                    'Indexer Attestation: must be signed with the allocationId'
                );

                require(
                    allocationB[PARTICIPANT_GATEWAY].amount ==
                        allocationA[PARTICIPANT_GATEWAY].amount.sub(
                            providedStateA.variable.paymentAmount
                        ),
                    'Indexer Attestation: Gateway funds must be decremented by payment amount'
                );

                require(
                    allocationB[PARTICIPANT_INDEXER].amount ==
                        allocationA[PARTICIPANT_INDEXER].amount.add(
                            providedStateA.variable.paymentAmount
                        ),
                    'Indexer Attestation: Indexer funds must be incremented by payment amount'
                );

                // If there is a zero responseCID the query has been rejected
            } else {
                require(
                    providedStateB.variable.requestCID == 0,
                    'Indexer Reject: RequestCID must be zero'
                );

                require(
                    isZero(providedStateB.variable.signature),
                    'Indexer Rject: Signature must be zero'
                );

                require(
                    allocationB[PARTICIPANT_INDEXER].amount ==
                        allocationA[PARTICIPANT_INDEXER].amount,
                    'Indexer Reject: Indexer funds must not change'
                );
                require(
                    allocationB[PARTICIPANT_GATEWAY].amount ==
                        allocationA[PARTICIPANT_GATEWAY].amount,
                    'Indexer Reject: Gateway funds must not change'
                );
            }
        }
        return true;
    }

    function isZero(bytes memory data) private pure returns (bool) {
        for (uint256 i = 0; i < data.length; i++) {
            if (data[0] != 0) {
                return false;
            }
        }
        return true;
    }

     /**
     * @notice Check for equality of two byte strings
     * @dev Check for equality of two byte strings
     * @param _preBytes One bytes string
     * @param _postBytes The other bytes string
     * @return true if the bytes are identical, false otherwise.
     */
    function _bytesEqual(bytes memory _preBytes, bytes memory _postBytes)
        internal
        pure
        returns (bool)
    {
        // copied from https://www.npmjs.com/package/solidity-bytes-utils/v/0.1.1
        bool success = true;

        assembly {
            let length := mload(_preBytes)

            // if lengths don't match the arrays are not equal
            switch eq(length, mload(_postBytes))
                case 1 {
                    // cb is a circuit breaker in the for loop since there's
                    //  no said feature for inline assembly loops
                    // cb = 1 - don't breaker
                    // cb = 0 - break
                    let cb := 1

                    let mc := add(_preBytes, 0x20)
                    let end := add(mc, length)

                    for {
                        let cc := add(_postBytes, 0x20)
                        // the next line is the loop condition:
                        // while(uint256(mc < end) + cb == 2)
                    } eq(add(lt(mc, end), cb), 2) {
                        mc := add(mc, 0x20)
                        cc := add(cc, 0x20)
                    } {
                        // if any of these checks fails then arrays are not equal
                        if iszero(eq(mload(mc), mload(cc))) {
                            // unsuccess:
                            success := 0
                            cb := 0
                        }
                    }
                }
                default {
                    // unsuccess:
                    success := 0
                }
        }

        return success;
    }

    // EIP-712 TYPE HASH CONSTANTS
    bytes32 private constant DOMAIN_TYPE_HASH = keccak256(
        'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)'
    );

    bytes32 private constant RECEIPT_TYPE_HASH = keccak256(
        'Receipt(bytes32 requestCID,bytes32 responseCID,bytes32 subgraphDeploymentID)'
    );

    // EIP-712 DOMAIN SEPARATOR CONSTANTS
    bytes32 private constant DOMAIN_NAME_HASH = keccak256('Graph Protocol');
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256('0');
    bytes32
        private constant DOMAIN_SALT = 0xa070ffb1cd7409649bf77822cce74495468e06dbfaef09556838bf188679b9c2;

    function recoverAttestationSigner(AttestationAppData memory appData)
        public
        pure
        returns (address)
    {
        return
            ECDSA.recover(
                keccak256(
                    abi.encodePacked(
                        '\x19\x01',
                        keccak256(
                            abi.encode(
                                DOMAIN_TYPE_HASH,
                                DOMAIN_NAME_HASH,
                                DOMAIN_VERSION_HASH,
                                appData.constants.chainId,
                                appData.constants.verifyingContract,
                                DOMAIN_SALT
                            )
                        ),
                        keccak256(
                            abi.encode(
                                RECEIPT_TYPE_HASH,
                                appData.variable.requestCID,
                                appData.variable.responseCID,
                                appData.constants.subgraphDeploymentID
                            )
                        )
                    )
                ),
                appData.variable.signature
            );
    }
}
