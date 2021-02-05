# Conditional Graph payments

## What is a `ForceMove` app?

### Short answer

[https://docs.statechannels.org/contract-api/natspec/IForceMoveApp](https://docs.statechannels.org/contract-api/natspec/IForceMoveApp)

### Medium answer

It's a smart contract that implements a `validTransition` function with the following signature.

```swift
struct VariablePart {
 bytes outcome,
 bytes appData
}

function validTransition(
	struct ForceMoveApp.VariablePart a,
	struct ForceMoveApp.VariablePart b,
	uint48 turnNumB,
	uint256 nParticipants
) external pure returns(bool)
```

The `outcome` is an encoding (using the ethereum ABI encoder) of a non-simple type `OutcomItem[]` where `OutcomeItem` is defined [here](https://docs.statechannels.org/contract-api/natspec/Outcome).

The `appData` is an encoding of an arbitrary solidity data type, designed specifically for the channel's application.
It is entirely possible for `appData` to always be the null `0x` bytes value.

### Example

[This](https://github.com/statechannels/statechannels/blob/ee1a0aa/packages/nitro-protocol/contracts/examples/SingleAssetPayments.sol) is a payment channel where any participant can send any of its peers any amount of its remaining funds, on their turn.
This particular app uses no `appData`.

[This](https://github.com/statechannels/apps/blob/master/packages/rps/contracts/RockPaperScissors.sol) is a more complicated example, implementing the rules of Rock Paper Scissors. Thus, it makes use of app data to store game state, such as the current player's move.

## What is the `AttestationApp`?

It is a `ForceMove` app with the following intended properties:

1. On the gateway's turn, it embeds a query ID (`queryCID`) and an allocation id (`allocationId`) in the app data.
2. On the indexer's turn, it embeds an attestation in the app data
   1. It deducts the `paymentAmount` from the gateway's total in the outcome, and adds it to the indexer's total for that allocation. If the indexer hasn't been payed yet through that allocation, a new outcome item is created
   2. It signs the attestation

**Reminder**: Peers take turns in Nitro state channels. In these channels, the gateway takes even turns, and the indexer takes odd turns. For example, if the current turn number is 7, then it is the gateway's turn to update the channel on turn 8, because it is even.

The _outcome_ in the AttestationApp should be a single `AssetOutcome` where the asset holder address is the `GRTAssetHolder`.

The _app data_ in the AttestationApp contains at most one of:

1. A "Query request", which is a `bytes32 requestCID` as well as a `uint256 paymentAmount`
2. An "Attestation", which is a `bytes32 responseCID` as well as a signature.

It is possible for the app data to contain neither of (1) or (2).
This is allowed in two cases:

1. In the "starting state"
2. When the indexer declines a query.

### Security

An honest indexer would

1. execute the query
2. compute the query result's `responseCID` from the query result
3. constructs the attestation, which is composed of the `requestCID`, the `responseCID`, and the `subgraphDeploymentID`
4. signs the attestation

A malicious indexer can skip (1), and put a random value for the `responseCID`.
Thus, signing the attestation does not guarantee that the query result is correct.

The gateway can, in this case, penalize the indexer's stake by _challenging_ the result. The penalty is very severe, providing an incentive for indexers to be honest.

## Testing

There is [one positive test case](https://github.com/statechannels/graph-payments/blob/a995f4bfaa1927f62821bcbd27955beed50875bd/packages/statechannels-contracts/test/attestationApp.test.ts#L175-L182) for each possible (state, event) pair in the happy path.

In addition, there are [some test cases](https://github.com/statechannels/graph-payments/blob/a995f4bfaa1927f62821bcbd27955beed50875bd/packages/statechannels-contracts/test/attestationApp.test.ts#L200-L207) of invalid transitions.

These are tested against contracts deployed to a local ganache network.
