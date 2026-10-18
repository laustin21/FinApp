import { LOGO_SRC } from "./logoData";

// The Gatorstar logo: the gator with the gold star. The image is embedded in the code
// (logoData.ts) so it works on every deploy, not just on the computer that has the file.
export function Logo({ size = 36, className = "" }: { size?: number; className?: string }) {
  return <img alt="Gatorstar" className={`shrink-0 select-none ${className}`} draggable={false} height={size} src={LOGO_SRC} width={size} />;
}
