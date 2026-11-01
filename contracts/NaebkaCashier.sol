// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Naebka cashier on Sepolia: players deposit test ETH and the core credits play tokens (NTK).
/// Same patterns as the course's ClassroomCounter: immutable owner, custom errors, events.
/// Remix: compiler 0.8.24, optimiser on (200 runs), EVM Shanghai, deploy with Value = 0.
contract NaebkaCashier {
    uint256 public constant MIN_DEPOSIT = 0.0001 ether;
    uint256 public constant MAX_DEPOSIT = 0.05 ether;

    address public immutable owner;
    /// Withdrawal ids already paid, so the same ledger withdrawal can never be paid twice.
    mapping(bytes32 => bool) public paid;

    event Deposited(address indexed player, uint256 amount);
    event PaidOut(address indexed player, uint256 amount, bytes32 indexed withdrawalId);

    error OnlyOwner();
    error AmountOutOfRange();
    error AlreadyPaid();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    // Anyone can deposit. The core watches Deposited events and credits the account linked to msg.sender.
    // There is no receive() or fallback(), so plain ETH sent to the contract address is rejected.
    function deposit() external payable {
        if (msg.value < MIN_DEPOSIT || msg.value > MAX_DEPOSIT) revert AmountOutOfRange();
        emit Deposited(msg.sender, msg.value);
    }

    // Only the deployer can pay out. Not used by the app yet (withdrawals are a later phase).
    function payout(address to, uint256 amount, bytes32 withdrawalId) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (paid[withdrawalId]) revert AlreadyPaid();
        paid[withdrawalId] = true;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PaidOut(to, amount, withdrawalId);
    }
}
