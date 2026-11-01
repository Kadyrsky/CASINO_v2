// Deploys NaebkaCashier to Sepolia and prints the two lines to put in .env.
//
//   DEPLOYER_PRIVATE_KEY=0x...        the owner key (a Sepolia test account; keep it in MetaMask too)
//   OPERATOR_ADDRESS=0x...            optional: the server's payout account (NAEBKA_ETH_OPERATOR_KEY's address)
//   FUND_ETH=0.2                      optional: house money for withdrawals
//   npm run deploy:sepolia
const { ethers, network } = require('hardhat');

async function main() {
  if (network.name !== 'sepolia') throw new Error('Run with --network sepolia (npm run deploy:sepolia).');
  const [owner] = await ethers.getSigners();
  if (!owner) throw new Error('Set DEPLOYER_PRIVATE_KEY to a Sepolia test key first.');
  console.log(`Deploying from ${owner.address} (balance ${ethers.formatEther(await ethers.provider.getBalance(owner))} ETH)`);

  const cashier = await (await ethers.getContractFactory('NaebkaCashier')).deploy();
  const receipt = await cashier.deploymentTransaction().wait();
  const address = await cashier.getAddress();
  console.log(`Deployed at ${address} in block ${receipt.blockNumber}`);

  if (process.env.OPERATOR_ADDRESS) {
    await (await cashier.setOperator(process.env.OPERATOR_ADDRESS)).wait();
    console.log(`Operator set to ${process.env.OPERATOR_ADDRESS}`);
  }
  if (process.env.FUND_ETH) {
    await (await cashier.fund({ value: ethers.parseEther(process.env.FUND_ETH) })).wait();
    console.log(`Funded with ${process.env.FUND_ETH} ETH`);
  }

  console.log('\nPut these in .env:');
  console.log(`NAEBKA_ETH_CONTRACT_ADDRESS=${address}`);
  console.log(`NAEBKA_ETH_DEPLOY_BLOCK=${receipt.blockNumber}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
