import type { SymbolMeta } from "./symbols";

const colorMap: Record<SymbolMeta["asset"], string> = {
  btc: "bg-asset-btc",
  eth: "bg-asset-eth",
  sol: "bg-asset-sol",
  xrp: "bg-asset-xrp",
  doge: "bg-asset-doge",
  avax: "bg-asset-avax",
  link: "bg-asset-link",
};

const sizeMap = {
  sm: "w-5 h-5 text-2xs",
  md: "w-7 h-7 text-xs",
  lg: "w-9 h-9 text-sm",
};

export function AssetGlyph({
  meta,
  size = "md",
}: {
  meta: SymbolMeta;
  size?: keyof typeof sizeMap;
}) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full text-paper font-semibold ${colorMap[meta.asset]} ${sizeMap[size]}`}
      aria-hidden="true"
    >
      {meta.symbol[0]}
    </span>
  );
}
