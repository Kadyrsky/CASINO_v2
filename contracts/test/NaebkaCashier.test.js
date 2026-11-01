const { expect } = require('chai');
const { ethers } = require('hardhat');

const eth = (n) => ethers.parseEther(String(n));
const withdrawalId = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);

async function nextDay() {
  await ethers.provider.send('evm_increaseTime', [24 * 60 * 60]);
  await ethers.provider.send('evm_mine', []);
}

describe('NaebkaCashier', () => {
  let cashier, owner, operator, player, other;

  beforeEach(async () => {
    [owner, operator, player, other] = await ethers.getSigners();
    cashier = await (await ethers.getContractFactory('NaebkaCashier')).deploy();
    await cashier.setOperator(operator.address);
    await cashier.fund({ value: eth(1) });
  });

  describe('deposits', () => {
    it('accepts deposits inside the limits and emits Deposited', async () => {
      await expect(cashier.connect(player).deposit({ value: eth(0.001) }))
        .to.emit(cashier, 'Deposited')
        .withArgs(player.address, eth(0.001));
    });

    it('rejects deposits outside the limits', async () => {
      await expect(cashier.connect(player).deposit({ value: eth(0.00001) })).to.be.revertedWithCustomError(cashier, 'AmountOutOfRange');
      await expect(cashier.connect(player).deposit({ value: eth(1) })).to.be.revertedWithCustomError(cashier, 'AmountOutOfRange');
    });

    it('rejects plain ETH transfers (there is no receive function)', async () => {
      await expect(player.sendTransaction({ to: await cashier.getAddress(), value: eth(0.001) })).to.be.reverted;
    });
  });

  describe('payouts', () => {
    it('lets the operator pay a withdrawal once', async () => {
      const id = withdrawalId(1);
      await expect(cashier.connect(operator).payout(player.address, eth(0.01), id))
        .to.changeEtherBalances([player, cashier], [eth(0.01), -eth(0.01)]);
      expect(await cashier.paid(id)).to.equal(true);
      await expect(cashier.connect(operator).payout(player.address, eth(0.01), id)).to.be.revertedWithCustomError(cashier, 'AlreadyPaid');
    });

    it('emits PaidOut with the withdrawal id', async () => {
      await expect(cashier.connect(operator).payout(player.address, eth(0.01), withdrawalId(2)))
        .to.emit(cashier, 'PaidOut')
        .withArgs(player.address, eth(0.01), withdrawalId(2));
    });

    it('lets only the operator or the owner pay', async () => {
      await expect(cashier.connect(other).payout(other.address, eth(0.01), withdrawalId(3))).to.be.revertedWithCustomError(cashier, 'OnlyOperator');
      await expect(cashier.connect(owner).payout(player.address, eth(0.01), withdrawalId(3))).to.not.be.reverted;
    });

    it('stops a removed operator', async () => {
      await cashier.setOperator(ethers.ZeroAddress);
      await expect(cashier.connect(operator).payout(player.address, eth(0.01), withdrawalId(4))).to.be.revertedWithCustomError(cashier, 'OnlyOperator');
    });

    it('caps a single payout', async () => {
      await expect(cashier.connect(operator).payout(player.address, eth(0.06), withdrawalId(5))).to.be.revertedWithCustomError(cashier, 'AmountOutOfRange');
      await expect(cashier.connect(operator).payout(player.address, 0, withdrawalId(5))).to.be.revertedWithCustomError(cashier, 'AmountOutOfRange');
      await expect(cashier.connect(operator).payout(ethers.ZeroAddress, eth(0.01), withdrawalId(5))).to.be.revertedWithCustomError(cashier, 'ZeroAddress');
    });

    it('caps a day of payouts and starts again the next day', async () => {
      await cashier.setDailyPayoutLimit(eth(0.1));
      await cashier.connect(operator).payout(player.address, eth(0.05), withdrawalId(10));
      await cashier.connect(operator).payout(player.address, eth(0.05), withdrawalId(11));
      await expect(cashier.connect(operator).payout(player.address, eth(0.01), withdrawalId(12))).to.be.revertedWithCustomError(cashier, 'DailyLimitReached');
      await nextDay();
      await expect(cashier.connect(operator).payout(player.address, eth(0.01), withdrawalId(12))).to.not.be.reverted;
      expect(await cashier.paidToday()).to.equal(eth(0.01));
    });

    it('fails a payout the contract cannot afford and leaves it unpaid', async () => {
      await cashier.withdrawHouse(owner.address, eth(1));
      await expect(cashier.connect(operator).payout(player.address, eth(0.01), withdrawalId(20))).to.be.revertedWithCustomError(cashier, 'TransferFailed');
      expect(await cashier.paid(withdrawalId(20))).to.equal(false);
    });
  });

  describe('pause', () => {
    it('stops deposits and payouts; the operator can pause but only the owner resumes', async () => {
      await expect(cashier.connect(operator).pause()).to.emit(cashier, 'Paused').withArgs(operator.address);
      await expect(cashier.connect(player).deposit({ value: eth(0.001) })).to.be.revertedWithCustomError(cashier, 'IsPaused');
      await expect(cashier.connect(operator).payout(player.address, eth(0.01), withdrawalId(30))).to.be.revertedWithCustomError(cashier, 'IsPaused');
      await expect(cashier.connect(operator).unpause()).to.be.revertedWithCustomError(cashier, 'OnlyOwner');
      await cashier.unpause();
      await expect(cashier.connect(player).deposit({ value: eth(0.001) })).to.not.be.reverted;
    });

    it('cannot be used by strangers', async () => {
      await expect(cashier.connect(other).pause()).to.be.revertedWithCustomError(cashier, 'OnlyOperator');
    });
  });

  describe('owner', () => {
    it('keeps admin functions to the owner', async () => {
      await expect(cashier.connect(operator).setOperator(other.address)).to.be.revertedWithCustomError(cashier, 'OnlyOwner');
      await expect(cashier.connect(operator).setDailyPayoutLimit(eth(10))).to.be.revertedWithCustomError(cashier, 'OnlyOwner');
      await expect(cashier.connect(operator).withdrawHouse(operator.address, eth(0.1))).to.be.revertedWithCustomError(cashier, 'OnlyOwner');
      await expect(cashier.connect(player).fund({ value: eth(0.1) })).to.be.revertedWithCustomError(cashier, 'OnlyOwner');
    });

    it('withdraws house funds', async () => {
      await expect(cashier.withdrawHouse(other.address, eth(0.3))).to.changeEtherBalances([other, cashier], [eth(0.3), -eth(0.3)]);
    });

    it('moves ownership in two steps', async () => {
      await cashier.transferOwnership(other.address);
      expect(await cashier.owner()).to.equal(owner.address);
      await expect(cashier.connect(player).acceptOwnership()).to.be.revertedWithCustomError(cashier, 'NotPendingOwner');
      await expect(cashier.connect(other).acceptOwnership()).to.emit(cashier, 'OwnershipTransferred').withArgs(owner.address, other.address);
      expect(await cashier.owner()).to.equal(other.address);
      await expect(cashier.unpause()).to.be.revertedWithCustomError(cashier, 'OnlyOwner');
    });
  });

  describe('what the core relies on', () => {
    // core/src/main/java/win/naebka/eth/EthPayout.java builds these calls by hand.
    it('has the selectors the core uses', () => {
      expect(cashier.interface.getFunction('payout').selector).to.equal('0x9de34c05');
      expect(cashier.interface.getFunction('paid').selector).to.equal('0xadd89bb2');
      expect(cashier.interface.getFunction('paused').selector).to.equal('0x5c975abb');
    });

    it('keeps the Deposited event the deposit poller reads', () => {
      expect(cashier.interface.getEvent('Deposited').topicHash).to.equal(
        '0x2da466a7b24304f47e87fa2e1e5a81b9831ce54fec19055ce277ca2f39ba42c4',
      );
    });
  });
});
