// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Naebka cashier on Sepolia: players deposit test ETH and the core credits play tokens (NTK); the core pays
/// withdrawals back with payout(). Same patterns as the course's ClassroomCounter: custom errors and events.
///
/// v2 adds what a cashier needs before it holds anything of value:
/// - an operator: the server pays out with its own key, so the owner key can stay in MetaMask;
/// - limits: at most MAX_PAYOUT per payout and dailyPayoutLimit per UTC day, so a leaked operator key can't empty it;
/// - pause: the owner or the operator can stop deposits and payouts at once; only the owner can restart them;
/// - two-step ownership transfer, and house funding / withdrawal for the owner.
///
/// Remix: compiler 0.8.24, optimiser on (200 runs), EVM Shanghai, deploy with Value = 0.
/// Or with Hardhat: npm run deploy:sepolia in contracts/ (see the README's web3 section).
contract NaebkaCashier {
    uint256 public constant MIN_DEPOSIT = 0.0001 ether;
    uint256 public constant MAX_DEPOSIT = 0.05 ether;
    uint256 public constant MAX_PAYOUT = 0.05 ether;

    address public owner;
    address public pendingOwner;
    /// The server's payout key. address(0) = only the owner can pay out.
    address public operator;
    bool public paused;

    uint256 public dailyPayoutLimit = 0.5 ether;
    /// UTC day (block.timestamp / 1 days) that paidToday counts.
    uint256 public payoutDay;
    uint256 public paidToday;

    /// Withdrawal ids already paid, so the same ledger withdrawal can never be paid twice.
    mapping(bytes32 => bool) public paid;

    event Deposited(address indexed player, uint256 amount);
    event PaidOut(address indexed player, uint256 amount, bytes32 indexed withdrawalId);
    event Funded(address indexed from, uint256 amount);
    event HouseWithdrawn(address indexed to, uint256 amount);
    event OperatorChanged(address indexed operator);
    event DailyPayoutLimitChanged(uint256 limit);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OnlyOwner();
    error OnlyOperator();
    error NotPendingOwner();
    error AmountOutOfRange();
    error AlreadyPaid();
    error DailyLimitReached();
    error IsPaused();
    error ZeroAddress();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOperatorOrOwner() {
        if (msg.sender != operator && msg.sender != owner) revert OnlyOperator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // Anyone can deposit. The core watches Deposited events and credits the account linked to msg.sender.
    // There is no receive() or fallback(), so plain ETH sent to the contract address is rejected.
    function deposit() external payable whenNotPaused {
        if (msg.value < MIN_DEPOSIT || msg.value > MAX_DEPOSIT) revert AmountOutOfRange();
        emit Deposited(msg.sender, msg.value);
    }

    /// Pays a withdrawal the core has already taken out of the player's token balance.
    function payout(address to, uint256 amount, bytes32 withdrawalId) external onlyOperatorOrOwner whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > MAX_PAYOUT) revert AmountOutOfRange();
        if (paid[withdrawalId]) revert AlreadyPaid();

        uint256 day = block.timestamp / 1 days;
        if (day != payoutDay) {
            payoutDay = day;
            paidToday = 0;
        }
        if (paidToday + amount > dailyPayoutLimit) revert DailyLimitReached();

        // Effects before the external call, so a re-entering receiver finds the id already paid.
        paidToday += amount;
        paid[withdrawalId] = true;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PaidOut(to, amount, withdrawalId);
    }

    /// House money for payouts (deposits stay in the contract as well).
    function fund() external payable onlyOwner {
        emit Funded(msg.sender, msg.value);
    }

    function withdrawHouse(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit HouseWithdrawn(to, amount);
    }

    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorChanged(newOperator);
    }

    function setDailyPayoutLimit(uint256 limit) external onlyOwner {
        dailyPayoutLimit = limit;
        emit DailyPayoutLimitChanged(limit);
    }

    /// The server pauses on its own if it sees something wrong; a human (the owner) decides when to resume.
    function pause() external onlyOperatorOrOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
