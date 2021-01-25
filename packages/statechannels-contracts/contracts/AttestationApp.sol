/* SPDX-License-Identifier: UNLICENSED */

pragma solidity ^0.7.4;
pragma experimental ABIEncoderV2;

import '@statechannels/nitro-protocol/contracts/interfaces/IForceMoveApp.sol';
import '@statechannels/nitro-protocol/contracts/Outcome.sol';
import '@openzeppelin/contracts/cryptography/ECDSA.sol';
import '@openzeppelin/contracts/math/SafeMath.sol';

contract AttestationApp is IForceMoveApp {
    using SafeMath for uint256;

    struct ConstantAppData {
        uint256 chainId;
        address verifyingContract;
        bytes32 subgraphDeploymentID;
        uint16 maxAllocationItems;
    }

    struct VariableAppData {
        address allocationId;
        uint256 paymentAmount;
        bytes32 requestCID;
        bytes32 responseCID;
        bytes signature;
    }

    struct AttestationAppData {
        ConstantAppData constants;
        VariableAppData variable;
    }

    uint8 constant GATEWAY_IDX = 0;

    function validTransition(
        VariablePart calldata a,
        VariablePart calldata b,
        uint48 turnNumB,
        uint256 nParticipants
    ) external override pure returns (bool) {
        Outcome.AssetOutcome memory assetOutcomeA;
        Outcome.AssetOutcome memory assetOutcomeB;
        (assetOutcomeA, assetOutcomeB) = requireAttestationOutcome(a.outcome, b.outcome);

        AttestationAppData memory appDataA = abi.decode(a.appData, (AttestationAppData));
        AttestationAppData memory appDataB = abi.decode(b.appData, (AttestationAppData));

        // Validate the constants
        require(
            _bytesEqual(abi.encode(appDataA.constants), abi.encode(appDataB.constants)),
            'Constants must not change'
        );

        require(nParticipants == 2, 'Must be a 2-party channels');

        // Validate the variable parts
        if (turnNumB % 2 == GATEWAY_IDX) {
            requireConditionalPayment(appDataB, assetOutcomeA, assetOutcomeB);
        } else {
            // Indexer moved
            if (appDataB.variable.responseCID != 0) {
                requireAttestationProvided(appDataA, appDataB, assetOutcomeA, assetOutcomeB);
            } else {
                requireQueryDeclined(appDataB, assetOutcomeA, assetOutcomeB);
            }
        }
        return true;
    }

    function requireAttestationOutcome(bytes memory outcomeABytes, bytes memory outcomeBBytes)
        internal
        pure
        returns (
            Outcome.AssetOutcome memory assetOutcomeA,
            Outcome.AssetOutcome memory assetOutcomeB
        )
    {
        Outcome.OutcomeItem[] memory outcomeA = abi.decode(outcomeABytes, (Outcome.OutcomeItem[]));
        Outcome.OutcomeItem[] memory outcomeB = abi.decode(outcomeBBytes, (Outcome.OutcomeItem[]));

        // Throws if more than one asset
        require(outcomeA.length == 1, 'outcomeA: Only one asset allowed');
        require(outcomeB.length == 1, 'outcomeB: Only one asset allowed');

        // Throws unless the assetoutcome is an allocation
        assetOutcomeA = abi.decode(outcomeA[0].assetOutcomeBytes, (Outcome.AssetOutcome));
        assetOutcomeB = abi.decode(outcomeB[0].assetOutcomeBytes, (Outcome.AssetOutcome));

        require(
            assetOutcomeA.assetOutcomeType == uint8(Outcome.AssetOutcomeType.Allocation),
            'outcomeA: AssetOutcomeType must be Allocation'
        );
        require(
            assetOutcomeB.assetOutcomeType == uint8(Outcome.AssetOutcomeType.Allocation),
            'outcomeB: AssetOutcomeType must be Allocation'
        );
    }

    function requireConditionalPayment(
        AttestationAppData memory appDataB,
        Outcome.AssetOutcome memory assetOutcomeA,
        Outcome.AssetOutcome memory assetOutcomeB
    ) internal pure {
        require(appDataB.variable.requestCID != 0, 'Gateway Query: RequestCID must be non-zero');
        require(appDataB.variable.responseCID == 0, 'Gateway Query: ResponseCID must be zero');

        require(isZero(appDataB.variable.signature), 'Gateway Query: Signature must be zero');
        require(
            appDataB.variable.paymentAmount > 0,
            'Gateway Query: Payment amount must be non-zero'
        );
        require(
            appDataB.variable.allocationId != address(0),
            'Gateway Query: allocationId must be non-zero'
        );
        require(
            _bytesEqual(
                assetOutcomeA.allocationOrGuaranteeBytes,
                assetOutcomeB.allocationOrGuaranteeBytes
            ),
            'Gateway Query: Outcome must not change'
        );
    }

    function requireAttestationProvided(
        AttestationAppData memory appDataA,
        AttestationAppData memory appDataB,
        Outcome.AssetOutcome memory assetOutcomeA,
        Outcome.AssetOutcome memory assetOutcomeB
    ) internal pure {
        address allocationId = appDataA.variable.allocationId;
        bytes32 paymentDestination = bytes32(uint256(allocationId));
        uint256 paymentAmount = appDataA.variable.paymentAmount;

        Outcome.AllocationItem[] memory previousAllocation = abi.decode(
            assetOutcomeA.allocationOrGuaranteeBytes,
            (Outcome.AllocationItem[])
        );
        Outcome.AllocationItem[] memory nextAllocation = abi.decode(
            assetOutcomeB.allocationOrGuaranteeBytes,
            (Outcome.AllocationItem[])
        );

        uint256 maxAllocationItems = appDataA.constants.maxAllocationItems;
        require(nextAllocation.length <= maxAllocationItems, 'Max outcome items exceeded');

        // This probably isn't necessary, but it doesn't hurt.
        require(
            appDataB.variable.allocationId == allocationId,
            'Indexer turn: allocationId must match'
        );
        require(
            recoverAttestationSigner(appDataB) == allocationId,
            'Indexer Attestation: must be signed with the allocationId'
        );
        // Assert that the payment was made correctly.
        // First, check that the gateway made a payment.
        bytes32 gatewayDestination = previousAllocation[GATEWAY_IDX].destination;
        uint256 gatewayAmount = previousAllocation[GATEWAY_IDX].amount.sub(paymentAmount);
        expectAllocationItem(
            nextAllocation[GATEWAY_IDX],
            Outcome.AllocationItem(gatewayDestination, gatewayAmount),
            'Indexer Attestation: Gateway destination cannot change',
            'Indexer Attestation: Gateway funds must be decremented by payment amount'
        );
        // Next check that the indexer received a payment.
        // We first look for an existing outcome item for the given allocation id
        bool paymentDetected = false;
        for (uint256 idx = 1; idx < previousAllocation.length; idx++) {
            if (nextAllocation[idx].destination == paymentDestination) {
                // Ensure that the client correctly found an existing
                require(!paymentDetected, 'Indexer Attestation: duplicate destinations');
                paymentDetected = true;
                uint256 expectedAmount = previousAllocation[idx].amount.add(paymentAmount);
                expectAllocationItem(
                    nextAllocation[idx],
                    Outcome.AllocationItem(paymentDestination, expectedAmount),
                    'Indexer Attestation: unreachable', // We know that the destination much match within this block
                    'Indexer Attestation: Existing allocationId funds must be incremented by payment amount'
                );
            } else {
                expectAllocationItem(
                    nextAllocation[idx],
                    previousAllocation[idx],
                    'Indexer Attestation: Unrelated allocations cannot change destinations',
                    'Indexer Attestation: Unrelated allocations cannot receive payments'
                );
            }
        }
        if (!paymentDetected) {
            // This is the first time this allocation serviced a query in this channel.
            require(
                nextAllocation.length == previousAllocation.length + 1,
                'Indexer Attestation: new outcome items must be appended to the end'
            );
            expectAllocationItem(
                nextAllocation[nextAllocation.length - 1],
                Outcome.AllocationItem(paymentDestination, paymentAmount),
                'Indexer Attestation: New outcome items must have destination == paymentDestination',
                'Indexer Attestation: New outcome items must have amount == paymentAmount'
            );
        }
    }

    function requireQueryDeclined(
        AttestationAppData memory appDataB,
        Outcome.AssetOutcome memory assetOutcomeA,
        Outcome.AssetOutcome memory assetOutcomeB
    ) internal pure {
        // If there is a zero responseCID the query has been rejected
        require(appDataB.variable.requestCID == 0, 'Indexer Reject: RequestCID must be zero');
        require(isZero(appDataB.variable.signature), 'Indexer Reject: Signature must be zero');
        require(
            _bytesEqual(
                assetOutcomeA.allocationOrGuaranteeBytes,
                assetOutcomeB.allocationOrGuaranteeBytes
            ),
            'Indexer Reject: Outcome must not change'
        );
    }

    function isZero(bytes memory data) private pure returns (bool) {
        for (uint256 i = 0; i < data.length; i++) {
            if (data[0] != 0) {
                return false;
            }
        }
        return true;
    }

    function expectAllocationItem(
        Outcome.AllocationItem memory itemGiven,
        Outcome.AllocationItem memory itemExpected,
        string memory destinationRevertReason,
        string memory amountRevertReason
    ) internal pure {
        require(itemGiven.destination == itemExpected.destination, destinationRevertReason);
        require(itemGiven.amount == itemExpected.amount, amountRevertReason);
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
