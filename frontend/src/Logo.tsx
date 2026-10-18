// The Gatorstar logo (public/gatorstar-logo.png): the gator with the gold star.
export function Logo({ size = 36, className = "" }: { size?: number; className?: string }) {
  return <img alt="Gatorstar" className={`shrink-0 select-none ${className}`} draggable={false} height={size} src="/gatorstar-logo.png" width={size} />;
}
