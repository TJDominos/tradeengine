import type { WalletBalance } from '../app/types';

type BalanceBadgesProps = {
  balance?: WalletBalance;
};

export default function BalanceBadges({ balance }: BalanceBadgesProps) {
  if (!balance) {
    return <span className="text-xs text-slate-500">Loading...</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[10px] text-slate-300">
        USDC {balance.usdc}
      </span>
      <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[10px] text-slate-300">
        SOL {balance.sol}
      </span>
      {balance.tokens.slice(0, 2).map((token) => (
        <span
          key={`${token.network}-${token.mint}`}
          className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300"
        >
          {token.symbol} {token.amount}
        </span>
      ))}
    </div>
  );
}