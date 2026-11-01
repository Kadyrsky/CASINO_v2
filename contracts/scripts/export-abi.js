// Writes the compiled ABI to contracts/NaebkaCashier.abi.json (for Remix "At Address", Etherscan and other tools).
const fs = require('node:fs');
const path = require('node:path');

const artifact = path.join(__dirname, '..', 'artifacts', 'src', 'NaebkaCashier.sol', 'NaebkaCashier.json');
const out = path.join(__dirname, '..', 'NaebkaCashier.abi.json');
const { abi } = JSON.parse(fs.readFileSync(artifact, 'utf8'));
fs.writeFileSync(out, `${JSON.stringify(abi, null, 2)}\n`);
console.log(`Wrote ${abi.length} ABI entries to ${path.relative(process.cwd(), out)}`);
