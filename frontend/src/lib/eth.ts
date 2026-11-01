/**
 * MetaMask + Sepolia connection. A TypeScript port of the course lab's shared/wallet.js, with the same safeguards:
 * EIP-6963 discovery, a Sepolia-only chain check, and a revision counter so a request that started before an
 * account or network switch can never act on the new account.
 *
 * ethers is loaded on first use, so the header (which shows the connected account) does not pull it into every page.
 */
import type { BrowserProvider, Eip1193Provider, JsonRpcSigner } from 'ethers';
import { createRoot, createSignal } from 'solid-js';

const loadEthers = () => import('ethers');

export const SEPOLIA_CHAIN_ID = 11155111n;
const SEPOLIA_HEX = '0xaa36a7';

/**
 * Human-readable ABI of contracts/src/NaebkaCashier.sol: what the frontend calls, plus every custom error so ethers
 * can name a revert. Withdrawals are paid by the server (payout() with the operator key), not from the browser.
 */
export const CASHIER_ABI = [
  'function deposit() payable',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function MIN_DEPOSIT() view returns (uint256)',
  'function MAX_DEPOSIT() view returns (uint256)',
  'error OnlyOwner()',
  'error OnlyOperator()',
  'error NotPendingOwner()',
  'error AmountOutOfRange()',
  'error AlreadyPaid()',
  'error DailyLimitReached()',
  'error IsPaused()',
  'error ZeroAddress()',
  'error TransferFailed()',
  'event Deposited(address indexed player, uint256 amount)',
];

type Listener = (...args: unknown[]) => void;
interface InjectedWallet extends Eip1193Provider {
  isMetaMask?: boolean;
  providers?: InjectedWallet[];
  on?: (event: string, listener: Listener) => void;
}

declare global {
  interface Window {
    ethereum?: InjectedWallet;
  }
}

let announced: InjectedWallet | null = null;
window.addEventListener('eip6963:announceProvider', (event) => {
  const detail = (event as CustomEvent<{ info?: { rdns?: string }; provider?: InjectedWallet }>).detail;
  if (detail?.info?.rdns === 'io.metamask' && detail.provider) announced = detail.provider;
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

export const etherscanTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
export const etherscanAddress = (address: string) => `https://sepolia.etherscan.io/address/${address}`;
export const shortAddress = (a: string | null | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

/** Lab-style error messages (same cases as explain() in shared/wallet.js, plus the cashier's errors). */
export function explainEthError(e: unknown): string {
  const err = (e ?? {}) as {
    code?: unknown;
    info?: { error?: { code?: unknown } };
    revert?: { name?: string };
    shortMessage?: string;
    message?: string;
  };
  const code = err.code ?? err.info?.error?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return 'You rejected the request. Try again when you choose.';
  if (code === -32002) return 'A request is already pending. Open MetaMask.';
  if (code === 'INSUFFICIENT_FUNDS') return 'Not enough Sepolia test ETH for the amount plus gas.';
  if (err.revert?.name === 'AmountOutOfRange') return 'AmountOutOfRange: the deposit is outside the contract limits.';
  if (err.revert?.name === 'OnlyOwner') return 'OnlyOwner: only the deployer account can do this.';
  if (err.revert?.name === 'IsPaused') return 'The cashier is paused for now. Try again later.';
  if (code === 'TIMEOUT') return 'The wait timed out. The transaction was not cancelled. Check the transaction link.';
  return err.shortMessage || err.message || 'The operation failed.';
}

export const eth = createRoot(() => {
  const [account, setAccount] = createSignal<string | null>(null);
  const [network, setNetwork] = createSignal('Not connected');
  const [onSepolia, setOnSepolia] = createSignal(false);

  let wallet: InjectedWallet | null = null;
  let provider: BrowserProvider | null = null;
  let signer: JsonRpcSigner | null = null;
  let revision = 0;
  const changeListeners = new Set<() => void>();

  function invalidate() {
    revision++;
    provider = null;
    signer = null;
    setAccount(null);
    setOnSepolia(false);
    setNetwork('Reconnection required');
  }

  function selectWallet(): InjectedWallet {
    const selected = announced ?? (window.ethereum?.providers ?? [window.ethereum]).find((p) => p?.isMetaMask) ?? null;
    if (!selected) throw new Error('MetaMask was not found. Use the browser with the extension installed.');
    if (wallet !== selected) {
      wallet = selected;
      for (const name of ['accountsChanged', 'chainChanged', 'disconnect']) {
        selected.on?.(name, () => {
          invalidate();
          changeListeners.forEach((f) => f());
        });
      }
    }
    return selected;
  }

  async function connect() {
    const w = selectWallet();
    invalidate();
    const accounts = (await w.request({ method: 'eth_requestAccounts' })) as string[];
    const version = revision;
    if (!accounts.length) throw new Error('You have not authorised an account.');
    const { BrowserProvider } = await loadEthers();
    const p = new BrowserProvider(w, undefined, { cacheTimeout: -1 });
    const net = await p.getNetwork();
    if (version !== revision) throw new Error('The wallet changed meanwhile. Reconnect.');
    const sepolia = net.chainId === SEPOLIA_CHAIN_ID;
    setNetwork(sepolia ? 'Sepolia · 11155111' : `Other network: ${net.chainId}`);
    if (!sepolia) throw new Error('Switch to Sepolia, then reconnect.');
    const s = await p.getSigner(accounts[0]);
    const address = await s.getAddress();
    if (version !== revision) throw new Error('The wallet changed meanwhile. Reconnect.');
    provider = p;
    signer = s;
    setOnSepolia(true);
    setAccount(address);
  }

  async function switchToSepolia() {
    await selectWallet().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA_HEX }] });
  }

  /** Re-checks with MetaMask that the account and network are still the ones we connected. */
  async function requireCurrent(): Promise<{ provider: BrowserProvider; signer: JsonRpcSigner; version: number }> {
    if (!wallet || !provider || !signer || !account()) throw new Error('Connect MetaMask first.');
    const version = revision;
    const [chain, accounts] = (await Promise.all([
      wallet.request({ method: 'eth_chainId' }),
      wallet.request({ method: 'eth_accounts' }),
    ])) as [string, string[]];
    const current = account()!.toLowerCase();
    if (version !== revision || BigInt(chain) !== SEPOLIA_CHAIN_ID || !accounts.some((a) => a.toLowerCase() === current)) {
      invalidate();
      throw new Error('The account or network changed. Reconnect.');
    }
    return { provider, signer, version };
  }

  async function signMessage(message: string): Promise<string> {
    const { signer: s, version } = await requireCurrent();
    const signature = await s.signMessage(message);
    if (version !== revision) throw new Error('The wallet changed meanwhile. Start again.');
    return signature;
  }

  async function cashier(address: string) {
    const ctx = await requireCurrent();
    if ((await ctx.provider.getCode(address)) === '0x') throw new Error('There is no cashier contract at this Sepolia address.');
    const { Contract } = await loadEthers();
    return { ...ctx, contract: new Contract(address, CASHIER_ABI, ctx.signer) };
  }

  /** Reads MIN_DEPOSIT / MAX_DEPOSIT from the contract (in ETH, as decimal strings). */
  async function depositLimits(address: string): Promise<{ min: string; max: string }> {
    const { contract } = await cashier(address);
    const [min, max] = (await Promise.all([contract.getFunction('MIN_DEPOSIT')(), contract.getFunction('MAX_DEPOSIT')()])) as [
      bigint,
      bigint,
    ];
    const { formatEther } = await loadEthers();
    return { min: formatEther(min), max: formatEther(max) };
  }

  /**
   * Sends deposit() with `amountEth` and waits for one block. `onSubmitted` gets the hash as soon as it
   * exists: once submitted, the interface cannot undo it, so the link is shown even if waiting fails.
   */
  async function deposit(address: string, amountEth: string, onSubmitted: (hash: string) => void) {
    const { parseEther } = await loadEthers();
    let value: bigint;
    try {
      value = parseEther(amountEth.trim());
    } catch {
      throw new Error('Enter an amount in ETH, for example 0.001.');
    }
    if (value <= 0n) throw new Error('Enter an amount above zero.');
    const { contract, version } = await cashier(address);
    const tx = await contract.getFunction('deposit')({ value });
    onSubmitted(tx.hash);
    if (version !== revision) throw new Error('The wallet changed. Check the submitted transaction using the link.');
    const receipt = await tx.wait(1, 120_000);
    if (!receipt || receipt.status !== 1) throw new Error('The transaction failed. Check the link.');
    return receipt;
  }

  /** Called after any account/network/disconnect event from MetaMask. Returns an unsubscribe function. */
  function onChange(f: () => void) {
    changeListeners.add(f);
    return () => changeListeners.delete(f);
  }

  return {
    account,
    network,
    onSepolia,
    available: () => !!(announced ?? window.ethereum),
    connect,
    switchToSepolia,
    signMessage,
    depositLimits,
    deposit,
    onChange,
  };
});
